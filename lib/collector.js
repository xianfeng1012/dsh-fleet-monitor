/**
 * The collection loop: discover hosts, poll them, derive rates, persist.
 *
 * One instance owns the whole cycle. It is driven by a timer (default 30 s) and
 * can be kicked manually from the panel. Subscribers receive the same snapshot
 * the API serves, so the browser's live view and a manual refresh never disagree.
 *
 * @module dsh-fleet-monitor/collector
 */

import { discoverHosts, resolveAuth } from './hosts.js'
import { deriveRates } from './probe.js'
import { SLOW_SCRIPT, parseSlow } from './probe-slow.js'
import { ConnectionPool } from './pool.js'

/** Bucket width for the long-range rollup: five minutes, wall-clock aligned. */
const BUCKET_MS = 300_000

/** Rollups are kept for 30 days, matching the spec's analytics window. */
const ROLLUP_KEEP_MS = 30 * 24 * 60 * 60 * 1000

/** Daily traffic rows are kept for 400 days, so a year-over-year view exists. */
const DAILY_KEEP_MS = 400 * 24 * 60 * 60 * 1000

/** How often expired rollups are dropped, independent of the sweep cadence. */
const PRUNE_EVERY_MS = 60 * 60 * 1000

/**
 * Poll every discovered host once, persist the results, and notify subscribers.
 *
 * A host is never removed from the store because one poll failed: an unreachable
 * machine keeps its row with `status: 'offline'` so the panel shows *which* one
 * went dark. Only a host gone from every discovery source is forgotten, and that
 * is the caller's decision via {@link Collector#syncNodes}.
 */
export class Collector {
  /**
   * @param options - collector inputs.
   * @param options.getConfig - reads the live plugin config (interval, concurrency, manual hosts, ...).
   * @param options.store - the history store from `openStore`.
   */
  constructor(options) {
    this.getConfig = options.getConfig
    this.store = options.store
    this.pool = new ConnectionPool()
    this.timer = null
    this.running = false
    this.lastRunAt = 0
    this.lastRunMs = 0
    this.lastProblems = []
    this.hosts = []
    this.subscribers = new Set()
    // Called once per finished sweep with the snapshot. The plugin wires the
    // alert engine here rather than having the collector import it, so the
    // collection path stays free of notification code.
    this.onSweep = null
    // In-progress 5-minute buckets, one per alias. A bucket is accumulated in
    // memory and written whole on every sample inside it, then flushed one last
    // time when the clock moves to the next bucket.
    this.buckets = new Map()
    // The slow sweep has its own timer and its own guard: it must never block a
    // fast sweep or be skipped because the fast one is still running.
    this.slowTimer = null
    this.slowRunning = false
    this.lastSlowAt = 0
  }

  /** Subscribe to snapshots. @returns an unsubscribe function. */
  subscribe(listener) {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  /** @returns the snapshot shape the API and the panel both consume. */
  snapshot() {
    const config = this.getConfig()
    return {
      // "Is the plugin collecting?" is what a reader of the panel wants to know.
      // The in-flight flag is a separate fact: a sweep that finished two seconds
      // ago is not the same thing as a collector that has stopped.
      running: this.timer !== null,
      sweeping: this.running,
      intervalMs: config.intervalMs,
      slowIntervalMs: config.slowIntervalMs ?? null,
      lastRunAt: this.lastRunAt,
      lastRunMs: this.lastRunMs,
      lastSlowAt: this.lastSlowAt,
      backend: this.store.backend,
      historyKeep: this.store.keep,
      problems: this.lastProblems,
      nodes: this.store.latestAll().map(row => shapeRow(row, config)),
    }
  }

  /** Broadcast the current snapshot. */
  emit() {
    if (this.subscribers.size === 0) return
    const payload = this.snapshot()
    for (const listener of this.subscribers) {
      try {
        listener(payload)
      } catch {
        // A dead subscriber (a closed WebSocket) must not break the sweep.
      }
    }
  }

  /** Apply the live config to the pool limits before each sweep. */
  applyConfig() {
    const config = this.getConfig()
    this.pool.concurrency = Math.max(1, config.concurrency ?? 6)
    this.pool.execTimeoutMs = Math.max(1000, config.execTimeoutMs ?? 12_000)
    this.pool.connectTimeoutMs = Math.max(1000, config.connectTimeoutMs ?? 15_000)
  }

  /**
   * Run one full sweep.
   * @param reason - `'timer'`, `'manual'`, or `'start'`; echoed to subscribers.
   * @returns the snapshot produced by this sweep.
   */
  async refresh(reason = 'manual') {
    if (this.running) return this.snapshot()
    this.running = true
    this.applyConfig()
    const started = Date.now()
    try {
      const config = this.getConfig()
      const discovered = discoverHosts({
        dshHome: config.dshHome,
        sshDir: config.sshDir,
        manual: config.hosts,
        // Rows the operator added from the panel. They live in the store because
        // this is the one host source the plugin owns, and they must survive a
        // settings reset the way an imported source's entries would.
        panel: this.store.listManaged(),
      })
      this.lastProblems = discovered.problems
      this.hosts = discovered.hosts.filter(host => config.includeTag === '' || host.tags.includes(config.includeTag))

      // Forget nodes that no longer exist in any source.
      const live = new Set(this.hosts.map(host => host.alias))
      for (const row of this.store.latestAll()) {
        if (!live.has(row.alias)) this.store.forget(row.alias)
      }

      await Promise.all(this.hosts.map(async (host) => {
        const result = await this.pollHost(host, config)
        this.record(host, result, config)
      }))

      this.lastRunAt = Date.now()
      this.lastRunMs = this.lastRunAt - started
      this.pruneIfDue(this.lastRunAt)
    } finally {
      this.running = false
      this.emit()
      // Evaluation runs after subscribers have the snapshot, and never inside the
      // sweep's own await path: a notification endpoint that hangs must not hold
      // up the next collection round.
      if (this.onSweep !== null && this.onSweep !== undefined) {
        try {
          this.onSweep(this.snapshot())
        } catch {
          // An alert engine failure is not a collection failure.
        }
      }
    }
    return this.snapshot()
  }

  /**
   * Poll one host, honouring the skip rules.
   * @param host - discovered host.
   * @param config - live config.
   * @returns the pool result, or a `skipped` record.
   */
  async pollHost(host, config) {
    if (host.proxyJump !== undefined && host.proxyJump.length > 0) {
      return { ok: false, stage: 'skipped', error: 'host requires a jump chain (ProxyJump); not supported yet' }
    }
    if (config.excludeAliases.includes(host.alias)) {
      return { ok: false, stage: 'skipped', error: 'excluded by config' }
    }
    const authConfig = resolveAuth(host, {
      connectTimeoutMs: config.connectTimeoutMs,
      agentSocket: config.agentSocket === '' ? undefined : config.agentSocket,
    })
    return await this.pool.probe(host, authConfig)
  }

  /**
   * Hosts that came from an imported source, as the panel may show them.
   *
   * The panel reports these read-only: `dsh-ssh.json` and `~/.ssh/config` belong
   * to other tools, and an edit here would be overwritten on the next import.
   * @returns lightweight host records without any credential field.
   */
  listImported() {
    return (Array.isArray(this.hosts) ? this.hosts : [])
      .filter(host => host.source !== 'panel')
      .map(host => ({
        alias: host.alias,
        host: host.host,
        port: host.port,
        user: host.user,
        source: host.source,
        tags: host.tags,
        description: host.description ?? null,
      }))
  }

  /**
   * Drop one host from the live list immediately.
   *
   * A delete must not wait for the next sweep to stop showing the row: the panel
   * re-reads the snapshot right after the request returns.
   * @param alias - the host to drop.
   */
  dropHost(alias) {
    if (Array.isArray(this.hosts)) this.hosts = this.hosts.filter(host => host.alias !== alias)
  }

  /**
   * Probe one host described ad hoc, without persisting anything.
   *
   * Backs the panel's "test connection" action: the operator edits a form and
   * wants to know whether those credentials work *before* saving, so this must
   * not write a node row or a sample.
   * @param input - a validated host input from the route layer.
   * @returns the pool result, including the metrics a successful probe collected.
   */
  async probeOne(input) {
    const config = this.getConfig()
    this.applyConfig()
    const host = {
      alias: input.alias,
      host: input.host,
      port: input.port,
      user: input.user,
      auth: input.auth,
      proxyJump: [],
      tags: [],
      source: 'panel',
    }
    try {
      return await this.pollHost(host, config)
    } catch (error) {
      return {
        ok: false,
        stage: 'connect',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Persist one poll outcome: node status always, sample only on success.
   * @param host - the polled host.
   * @param result - pool result.
   * @param config - live config.
   */
  record(host, result, config) {
    const now = Date.now()
    if (!result.ok) {
      this.store.upsertNode({
        alias: host.alias,
        host: host.host,
        port: host.port,
        user: host.user,
        source: host.source,
        status: result.stage === 'skipped' ? 'skipped' : 'offline',
        lastError: result.error,
        latencyMs: result.latencyMs,
      })
      return
    }
    const metrics = result.metrics
    const previousRow = this.store.previous(host.alias)
    const previous = toCounters(previousRow)
    const rates = deriveRates(previous, metrics)
    // Hardware that only the slow probe can see. It is read back rather than
    // carried on the fast sample so a fast sweep never waits for `/sys` or
    // `nvidia-smi`; the value is therefore at most one slow interval stale.
    const hardware = this.store.hardwareFor(host.alias)
    this.store.upsertNode({
      alias: host.alias,
      host: host.host,
      port: host.port,
      user: host.user,
      source: host.source,
      status: 'online',
      lastOk: now,
      latencyMs: result.latencyMs,
      osName: metrics.os.name,
      kernel: metrics.os.kernel,
      arch: metrics.os.arch,
      cores: metrics.cpu.cores,
      cpuModel: metrics.cpu.model,
    })
    const sample = {
      ts: metrics.ts,
      cpuPct: rates.cpuPct,
      load1: metrics.load[0],
      load5: metrics.load[1],
      load15: metrics.load[2],
      memUsed: metrics.mem.usedBytes,
      memTotal: metrics.mem.totalBytes,
      swapUsed: metrics.mem.swapUsedBytes,
      swapTotal: metrics.mem.swapTotalBytes,
      diskUsed: metrics.disk.usedBytes,
      diskTotal: metrics.disk.totalBytes,
      rxBps: rates.rxBps,
      txBps: rates.txBps,
      rxBytes: metrics.net.rxBytes,
      txBytes: metrics.net.txBytes,
      tcp: metrics.conn.tcp,
      udp: metrics.conn.udp,
      procs: metrics.procs,
      uptimeSec: metrics.uptimeSec,
      // Raw monotonic counters, kept so the next poll can difference them.
      cpuTotal: metrics.cpu.totalJiffies,
      cpuIdle: metrics.cpu.idleJiffies,
      ctxSwitches: metrics.ctxSwitches,
      // Columns the slow probe fills in; null when it has never run.
      tempMax: hardware?.tempMax ?? null,
      gpuUtil: hardware?.gpu?.util ?? null,
      gpuMemUsed: hardware?.gpu?.memUsed ?? null,
      gpuMemTotal: hardware?.gpu?.memTotal ?? null,
      listenPorts: hardware?.listenPorts ?? null,
    }
    // Rollup first: `rebuildBucket` reads the raw table, so the sample must not
    // be written yet or the bucket would count it twice (once from disk, once
    // from the accumulator below).
    this.accumulate(host.alias, sample)
    this.store.insertSample(host.alias, sample)
    this.bumpDaily(host.alias, previousRow, metrics, config)
  }

  /**
   * Fold one sample into its 5-minute bucket and persist the bucket.
   *
   * Buckets are keyed by wall-clock alignment (`floor(ts / 5 min)`), not by "five
   * minutes since the last write", so two hosts observed at different times still
   * line up on the same x-axis, and a restart lands in the same bucket the
   * process was already in.
   *
   * @param alias - node alias.
   * @param sample - the sample just written to the raw table.
   */
  accumulate(alias, sample) {
    const bucketTs = Math.floor(sample.ts / BUCKET_MS) * BUCKET_MS
    let bucket = this.buckets.get(alias)
    if (bucket === undefined || bucket.ts !== bucketTs) {
      if (bucket !== undefined) this.writeBucket(alias, bucket)
      bucket = this.rebuildBucket(alias, bucketTs)
      this.buckets.set(alias, bucket)
    }
    bucket.count += 1
    bucket.cpu += sample.cpuPct ?? 0
    bucket.load1 += sample.load1 ?? 0
    bucket.memUsed += sample.memUsed ?? 0
    bucket.diskUsed += sample.diskUsed ?? 0
    bucket.rxBps += sample.rxBps ?? 0
    bucket.txBps += sample.txBps ?? 0
    bucket.tcp += sample.tcp ?? 0
    bucket.procs += sample.procs ?? 0
    bucket.tempMax = Math.max(bucket.tempMax, sample.tempMax ?? -Infinity)
    bucket.gpuUtil = Math.max(bucket.gpuUtil, sample.gpuUtil ?? -Infinity)
    bucket.memTotal = sample.memTotal ?? bucket.memTotal
    bucket.diskTotal = sample.diskTotal ?? bucket.diskTotal
    this.writeBucket(alias, bucket)
  }

  /**
   * Start a bucket from whatever the raw table already holds for it.
   *
   * Without this, a restart in the middle of a bucket would begin counting from
   * zero and the first write would replace the partial aggregate with a much
   * smaller one — a visible dip in every 30-day chart, once per DSH restart.
   *
   * @param alias - node alias.
   * @param bucketTs - the bucket start.
   * @returns a fresh accumulator seeded with the rows already on disk.
   */
  rebuildBucket(alias, bucketTs) {
    const bucket = {
      ts: bucketTs, count: 0,
      cpu: 0, load1: 0, memUsed: 0, diskUsed: 0, rxBps: 0, txBps: 0, tcp: 0, procs: 0,
      tempMax: -Infinity, gpuUtil: -Infinity, memTotal: null, diskTotal: null,
    }
    let rows = []
    try {
      rows = this.store.bucketSamples(alias, bucketTs)
    } catch {
      // A backend that cannot answer is treated as empty: the bucket then holds
      // only the samples this process sees, which is still correct from here on.
    }
    for (const row of rows) {
      if (row.ts >= bucketTs + BUCKET_MS) break
      bucket.count += 1
      bucket.cpu += row.cpu_pct ?? 0
      bucket.load1 += row.load1 ?? 0
      bucket.memUsed += row.mem_used ?? 0
      bucket.diskUsed += row.disk_used ?? 0
      bucket.rxBps += row.rx_bps ?? 0
      bucket.txBps += row.tx_bps ?? 0
      bucket.tcp += row.tcp ?? 0
      bucket.procs += row.procs ?? 0
      bucket.tempMax = Math.max(bucket.tempMax, row.temp_max ?? -Infinity)
      bucket.gpuUtil = Math.max(bucket.gpuUtil, row.gpu_util ?? -Infinity)
      bucket.memTotal = row.mem_total ?? bucket.memTotal
      bucket.diskTotal = row.disk_total ?? bucket.diskTotal
    }
    return bucket
  }

  /**
   * Persist one accumulated bucket, averaging the gauges and keeping the peak
   * temperature: a bucket that reported the mean temperature would hide exactly
   * the thermal spike the alert rule is looking for.
   *
   * @param alias - node alias.
   * @param bucket - the accumulator.
   */
  writeBucket(alias, bucket) {
    if (bucket.count === 0) return
    const mean = value => value / bucket.count
    try {
      this.store.upsertSample5m(alias, {
        ts: bucket.ts,
        cpuPct: mean(bucket.cpu),
        load1: mean(bucket.load1),
        memUsed: Math.round(mean(bucket.memUsed)),
        memTotal: bucket.memTotal,
        diskUsed: Math.round(mean(bucket.diskUsed)),
        diskTotal: bucket.diskTotal,
        rxBps: mean(bucket.rxBps),
        txBps: mean(bucket.txBps),
        tcp: Math.round(mean(bucket.tcp)),
        procs: Math.round(mean(bucket.procs)),
        tempMax: Number.isFinite(bucket.tempMax) ? bucket.tempMax : null,
        gpuUtil: Number.isFinite(bucket.gpuUtil) ? bucket.gpuUtil : null,
      })
    } catch {
      // The rollup is derived data. Losing one bucket must not fail the sweep
      // that already persisted the raw sample.
    }
  }

  /**
   * Add this observation to today's daily row.
   *
   * The traffic counters are monotonic, so the delta is only meaningful when the
   * previous sample is recent: after a gap (a sleeping laptop, a long SSH outage)
   * the difference spans the whole gap and would read as a traffic burst. The
   * day is a *local* calendar day — `toISOString` would put the first eight hours
   * of a Shanghai morning on the previous day's row.
   *
   * @param alias - node alias.
   * @param previousRow - the raw previous sample row, or undefined.
   * @param metrics - the probe that just landed.
   * @param config - live config, for the freshness window.
   */
  bumpDaily(alias, previousRow, metrics, config) {
    const day = localDay(metrics.ts)
    let rxBytes = 0
    let txBytes = 0
    const freshWindow = Math.max(60_000, (config.intervalMs ?? 30_000) * 2)
    if (previousRow !== undefined && previousRow.ts < metrics.ts
      && metrics.ts - previousRow.ts <= freshWindow) {
      rxBytes = Math.max(0, metrics.net.rxBytes - (previousRow.rx_bytes ?? metrics.net.rxBytes))
      txBytes = Math.max(0, metrics.net.txBytes - (previousRow.tx_bytes ?? metrics.net.txBytes))
    }
    try {
      this.store.bumpDaily(alias, day, { up: true, rxBytes, txBytes })
    } catch {
      // Same reasoning as the rollup: derived data never fails the sweep.
    }
  }

  /**
   * Run one slow sweep: the hardware that costs more than a `/proc` read.
   *
   * Deliberately separate from {@link refresh}: temperatures, GPU state and the
   * full partition list change slowly, and `nvidia-smi` can cost 200 ms per host.
   * Running this on the 30-second cadence would multiply the cost of every sweep
   * for data that would be identical. The fast sweep reads the last snapshot back
   * out of `host_hardware`, so the panel never waits on this one.
   *
   * @param reason - `'timer'` or `'manual'`; not currently echoed.
   */
  async slowRefresh(reason = 'slow') {
    if (this.slowRunning) return
    this.slowRunning = true
    this.applyConfig()
    try {
      const config = this.getConfig()
      const hosts = Array.isArray(this.hosts) ? this.hosts : []
      const timeoutMs = Math.max(5000, config.slowTimeoutMs ?? 20_000)
      await Promise.all(hosts.map(async (host) => {
        if (host.proxyJump !== undefined && host.proxyJump.length > 0) return
        if (config.excludeAliases.includes(host.alias)) return
        const authConfig = resolveAuth(host, {
          connectTimeoutMs: config.connectTimeoutMs,
          agentSocket: config.agentSocket === '' ? undefined : config.agentSocket,
        })
        try {
          const result = await this.pool.run(host, authConfig, SLOW_SCRIPT, timeoutMs)
          if (result.error !== undefined) {
            // A failed sweep clears the snapshot: showing yesterday's temperature
            // next to a live CPU reading implies the sensor is still answering.
            this.store.upsertHardware(host.alias, { ts: Date.now(), error: result.error })
            return
          }
          const parsed = parseSlow(result.stdout)
          this.store.upsertHardware(host.alias, {
            ts: parsed.ts,
            tempMax: parsed.tempMax,
            sensors: parsed.sensors,
            gpu: parsed.gpu,
            listenPorts: parsed.listenPorts,
            listenList: parsed.listenList,
            partitions: parsed.partitions,
            nics: parsed.nics,
            error: parsed.complete ? null : parsed.reason,
          })
        } catch (error) {
          this.store.upsertHardware(host.alias, {
            ts: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }))
      this.lastSlowAt = Date.now()
    } finally {
      this.slowRunning = false
      // The fast samples written after this point carry the new values; push one
      // snapshot now so the panel sees temperature without waiting 30 seconds.
      this.emit()
    }
  }

  /**
   * Drop expired rollups at most once an hour.
   *
   * Retention is not worth a statement per sweep on a 30-second timer, and it is
   * not worth a separate timer either: the collector already knows when it is
   * running.
   * @param now - current wall clock.
   */
  pruneIfDue(now) {
    if (now - (this.lastPruneAt ?? 0) < PRUNE_EVERY_MS) return
    this.lastPruneAt = now
    try {
      this.store.pruneSample5m(now - ROLLUP_KEEP_MS)
      this.store.pruneDaily(localDay(now - DAILY_KEEP_MS))
    } catch {
      // Retention failure is not a monitoring failure.
    }
  }

  /**
   * Re-arm both timers with the current config, without touching connections.
   *
   * The Settings tab can change the cadence at runtime, and a `setTimeout` chain
   * captures its delay only when it schedules: leaving the old chain in place
   * would mean a new interval took effect whenever the previous one happened to
   * fire, which can be an hour later than the operator expects.
   */
  rearm() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.slowTimer !== null) {
      clearTimeout(this.slowTimer)
      this.slowTimer = null
    }
    this.applyConfig()
    this.start()
  }

  /** Start the timer (idempotent). Runs one sweep immediately. */
  start() {
    if (this.timer !== null) return
    const tick = () => {
      this.refresh('timer').catch(() => {})
      this.timer = setTimeout(tick, Math.max(5000, this.getConfig().intervalMs))
      this.timer.unref?.()
    }
    tick()

    // The slow sweep waits for the first fast sweep: it needs a populated host
    // list, and a cold start should not open two connections per host at once.
    const slowTick = () => {
      this.slowRefresh('timer').catch(() => {})
      this.slowTimer = setTimeout(
        slowTick, Math.max(60_000, this.getConfig().slowIntervalMs ?? 300_000))
      this.slowTimer.unref?.()
    }
    this.slowTimer = setTimeout(slowTick, 20_000)
    this.slowTimer.unref?.()
  }

  /** Stop the timer and close every connection. */
  dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.slowTimer !== null) {
      clearTimeout(this.slowTimer)
      this.slowTimer = null
    }
    this.subscribers.clear()
    // Flush the open buckets: the process may be going away, and the aggregate
    // is the only copy of data that is otherwise already on disk.
    for (const [alias, bucket] of this.buckets) this.writeBucket(alias, bucket)
    this.buckets.clear()
    this.pool.dispose()
  }
}

/**
 * The local calendar day of a timestamp, as `YYYY-MM-DD`.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that converts to UTC first, so
 * every sample between midnight and 08:00 in Shanghai would be attributed to the
 * previous day and the daily traffic chart would be permanently shifted.
 *
 * @param ts - epoch milliseconds.
 * @returns the local day key.
 */
function localDay(ts) {
  const date = new Date(ts)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Project a stored sample row into the shape {@link deriveRates} consumes.
 *
 * The store keeps monotonic counters as nullable columns, so a row written by an
 * older schema (or by a degraded backend) yields `undefined` for the fields it
 * never captured. That matters: treating a missing baseline as zero would report
 * a 100 % CPU spike on the host's first sample after an upgrade.
 *
 * @param row - a `previous()` row, or undefined.
 * @returns the counters, or undefined when there is no earlier sample.
 */
function toCounters(row) {
  if (row === undefined || row === null) return undefined
  return {
    ts: row.ts,
    cpu: {
      totalJiffies: row.cpu_total ?? undefined,
      idleJiffies: row.cpu_idle ?? undefined,
    },
    net: {
      rxBytes: row.rx_bytes ?? undefined,
      txBytes: row.tx_bytes ?? undefined,
    },
    ctxSwitches: row.ctx_switches ?? undefined,
  }
}

/**
 * Project one store row into the API/panel shape, converting bytes to the units
 * the browser renders so no unit logic lives in two places.
 * @param row - a `latestAll()` row.
 * @param config - live config, for the alert thresholds.
 * @returns the node entry served by `/api/dsh-fleet-monitor/overview`.
 */
function shapeRow(row, config) {
  const cpuPct = row.cpu_pct ?? null
  const memPct = row.mem_total ? (row.mem_used / row.mem_total) * 100 : null
  const diskPct = row.disk_total ? (row.disk_used / row.disk_total) * 100 : null
  const alerts = []
  if (cpuPct !== null && cpuPct >= config.cpuAlertPct) alerts.push('cpu')
  if (memPct !== null && memPct >= config.memAlertPct) alerts.push('mem')
  if (diskPct !== null && diskPct >= config.diskAlertPct) alerts.push('disk')
  if (row.status !== 'online' && row.status !== 'skipped') alerts.push('offline')
  return {
    alias: row.alias,
    host: row.host,
    port: row.port,
    user: row.user,
    source: row.source,
    status: row.status,
    alerts,
    lastOk: row.last_ok ?? null,
    lastError: row.last_error ?? null,
    latencyMs: row.latency_ms ?? null,
    os: { name: row.os_name ?? null, kernel: row.kernel ?? null, arch: row.arch ?? null },
    cores: row.cores ?? null,
    cpuModel: row.cpu_model ?? null,
    ts: row.sample_ts ?? null,
    cpuPct,
    load: [row.load1 ?? null, row.load5 ?? null, row.load15 ?? null],
    mem: { used: row.mem_used ?? null, total: row.mem_total ?? null, pct: memPct },
    swap: { used: row.swap_used ?? null, total: row.swap_total ?? null },
    disk: { used: row.disk_used ?? null, total: row.disk_total ?? null, pct: diskPct },
    net: { rxBps: row.rx_bps ?? null, txBps: row.tx_bps ?? null, rxBytes: row.rx_bytes ?? null, txBytes: row.tx_bytes ?? null },
    conn: { tcp: row.tcp ?? null, udp: row.udp ?? null },
    procs: row.procs ?? null,
    uptimeSec: row.uptime_sec ?? null,
    // Filled from the slow sweep, so they can be one slow interval stale. The
    // alternative — waiting for /sys and nvidia-smi on every fast round — would
    // add seconds to a sweep that currently costs one round-trip per host.
    tempMax: row.temp_max ?? null,
    gpuUtil: row.gpu_util ?? null,
    listenPorts: row.listen_ports ?? null,
  }
}
