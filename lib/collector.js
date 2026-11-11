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
import { ConnectionPool } from './pool.js'

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
      running: this.running,
      intervalMs: config.intervalMs,
      lastRunAt: this.lastRunAt,
      lastRunMs: this.lastRunMs,
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
    } finally {
      this.running = false
      this.emit()
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
    const previous = toCounters(this.store.previous(host.alias))
    const rates = deriveRates(previous, metrics)
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
    this.store.insertSample(host.alias, {
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
    })
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
  }

  /** Stop the timer and close every connection. */
  dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.subscribers.clear()
    this.pool.dispose()
  }
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
  }
}
