/**
 * Agent-facing tools for the server monitor.
 *
 * Three read-mostly tools: read the fleet, read one node's history, and force a
 * sweep. The tools deliberately return the *shaped* rows the panel shows, so a
 * model reading them and an operator reading the panel never disagree about a
 * number.
 *
 * They are declared as plain tool objects instead of importing `defineTool`:
 * `defineTool` is a type-level helper in the host package, and depending on it
 * would pin this plugin to one host build. `ctx.tools.register` accepts the
 * object either way — but it does insist on `output.render`, so the shape below
 * is the contract, not a nicety.
 *
 * The output `schema` stays deliberately loose (`{ type: 'object' }`). The host
 * validates every returned value against it, and an over-tight schema turns
 * "add one useful field" into a breaking change for no benefit: the reader of
 * these tools is a model consuming the rendered text, not a typed call site.
 *
 * @module dsh-fleet-monitor/tools
 */

/**
 * Build the tool list.
 * @param deps - tool dependencies.
 * @param deps.collector - the collector owning the loop.
 * @param deps.store - the history store.
 * @returns tool objects for `ctx.tools.register`.
 */
export function makeTools(deps) {
  const { collector, store } = deps

  return [
    {
      name: 'fleet_snapshot',
      description: 'Read the current health of every monitored host: online/offline, CPU %, load, memory, disk, network rate, TCP connections, uptime, and which thresholds are alerting. Reads the already-collected sample; to force a fresh collection use fleet_refresh.',
      parameters: {
        filter: {
          type: 'string',
          enum: ['all', 'alerting', 'offline', 'online'],
          description: 'Which nodes to return. Defaults to all.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum nodes to return, sorted by severity then alias. Defaults to 50.',
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => text(renderSnapshot(value)),
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const filter = typeof args?.filter === 'string' ? args.filter : 'all'
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.trunc(args.limit)) : 50
        const snapshot = collector.snapshot()
        let nodes = snapshot.nodes
        if (filter === 'alerting') nodes = nodes.filter(node => node.alerts.length > 0)
        else if (filter === 'offline') nodes = nodes.filter(node => node.status === 'offline')
        else if (filter === 'online') nodes = nodes.filter(node => node.status === 'online')
        const severity = node => (node.status === 'offline' ? 0 : node.alerts.length > 0 ? 1 : 2)
        nodes = [...nodes].sort((a, b) => severity(a) - severity(b) || a.alias.localeCompare(b.alias)).slice(0, limit)
        return {
          collectedAt: snapshot.lastRunAt,
          intervalMs: snapshot.intervalMs,
          backend: snapshot.backend,
          total: snapshot.nodes.length,
          returned: nodes.length,
          nodes: nodes.map(node => ({
            alias: node.alias,
            host: node.host,
            status: node.status,
            alerts: node.alerts,
            latencyMs: node.latencyMs,
            lastError: node.lastError,
            cpuPct: node.cpuPct === null ? null : round(node.cpuPct, 1),
            load: node.load.map(value => (value === null ? null : round(value, 2))),
            memPct: node.mem.pct === null ? null : round(node.mem.pct, 1),
            memUsedBytes: node.mem.used,
            memTotalBytes: node.mem.total,
            diskPct: node.disk.pct === null ? null : round(node.disk.pct, 1),
            diskUsedBytes: node.disk.used,
            diskTotalBytes: node.disk.total,
            rxBps: wholeBytes(node.net.rxBps),
            txBps: wholeBytes(node.net.txBps),
            tcp: node.conn.tcp,
            procs: node.procs,
            uptimeSec: node.uptimeSec,
            os: node.os.name,
          })),
        }
      },
    },

    {
      name: 'fleet_history',
      description: 'Read one host\'s recent samples (CPU %, load, memory, disk, network rate) to tell a spike from a trend. Returns oldest-first so a caller can compute deltas.',
      parameters: {
        alias: { type: 'string', description: 'Host alias exactly as fleet_snapshot reported it.', required: true },
        minutes: { type: 'integer', description: 'How far back to read, in minutes. Defaults to 60.' },
        limit: { type: 'integer', description: 'Maximum samples, newest kept. Defaults to 240.' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => text(renderHistory(value)),
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const alias = typeof args?.alias === 'string' ? args.alias : ''
        if (alias === '') return { error: 'alias is required; call fleet_snapshot first to list aliases' }
        const minutes = Number.isFinite(args?.minutes) ? Math.max(1, Math.trunc(args.minutes)) : 60
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.trunc(args.limit)) : 240
        const from = Date.now() - minutes * 60_000
        const rows = store.history(alias, from, limit)
        if (rows.length === 0) {
          return { alias, minutes, points: [], note: 'no samples in this window; the host may be offline or outside the retention period' }
        }
        return {
          alias,
          minutes,
          backend: store.backend,
          points: rows.map(row => ({
            ts: row.ts,
            cpuPct: row.cpu_pct === null ? null : round(row.cpu_pct, 1),
            load1: row.load1 === null ? null : round(row.load1, 2),
            memPct: row.mem_total ? round((row.mem_used / row.mem_total) * 100, 1) : null,
            diskPct: row.disk_total ? round((row.disk_used / row.disk_total) * 100, 1) : null,
            rxBps: wholeBytes(row.rx_bps),
            txBps: wholeBytes(row.tx_bps),
            tcp: row.tcp,
            procs: row.procs,
          })),
        }
      },
    },

    {
      name: 'fleet_refresh',
      description: 'Run one collection sweep now across every monitored host and return the fresh snapshot. Each host costs one SSH round-trip, so avoid calling this in a loop; the background timer already collects every interval.',
      parameters: {},
      output: {
        schema: { type: 'object' },
        render: (_args, value) => text(renderRefresh(value)),
      },
      // Mutating: it opens real SSH connections to real machines.
      isConcurrencySafe: () => false,
      async execute() {
        const snapshot = await collector.refresh('tool')
        return {
          collectedAt: snapshot.lastRunAt,
          durationMs: snapshot.lastRunMs,
          total: snapshot.nodes.length,
          online: snapshot.nodes.filter(node => node.status === 'online').length,
          offline: snapshot.nodes.filter(node => node.status === 'offline').length,
          skipped: snapshot.nodes.filter(node => node.status === 'skipped').length,
          problems: snapshot.problems,
        }
      },
    },
  ]
}

/** One text content block — the only render shape these tools emit. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** The snapshot table a model reads instead of a wall of JSON. */
function renderSnapshot(value) {
  if (value === null || typeof value !== 'object') return 'no snapshot'
  const nodes = Array.isArray(value.nodes) ? value.nodes : []
  const lines = []
  const stamp = value.collectedAt === null || value.collectedAt === undefined
    ? 'never collected'
    : new Date(value.collectedAt).toISOString()
  const alerting = nodes.filter(node => Array.isArray(node.alerts) && node.alerts.length > 0).length
  lines.push(`${stamp} · ${value.returned ?? nodes.length}/${value.total ?? nodes.length} shown · every ${Math.round((value.intervalMs ?? 0) / 1000)}s · store ${value.backend ?? 'unknown'}${alerting > 0 ? ` · ${alerting} alerting` : ''}`)
  if (nodes.length === 0) {
    lines.push('no hosts: configure them in the panel (+ 添加服务器), or add hosts to dsh-ssh / ~/.ssh/config')
    return lines.join('\n')
  }
  lines.push([
    pad('ALIAS', 26), pad('STATUS', 8), pad('CPU', 7), pad('LOAD1', 7), pad('MEM', 7),
    pad('DISK', 7), pad('RX', 10), pad('TX', 10), pad('TCP', 5), pad('PROCS', 6), 'UPTIME',
  ].join(' '))
  for (const node of nodes) {
    lines.push([
      pad(node.alias, 26),
      pad(node.status, 8),
      pad(pct(node.cpuPct), 7),
      pad(num(Array.isArray(node.load) ? node.load[0] : null, 2), 7),
      pad(pct(node.memPct), 7),
      pad(pct(node.diskPct), 7),
      pad(rate(node.rxBps), 10),
      pad(rate(node.txBps), 10),
      pad(node.tcp ?? '--', 5),
      pad(node.procs ?? '--', 6),
      uptime(node.uptimeSec),
    ].join(' '))
  }
  const alerts = nodes.flatMap(node => (Array.isArray(node.alerts) ? node.alerts : []).map(alert => `${node.alias}: ${typeof alert === 'string' ? alert : JSON.stringify(alert)}`))
  if (alerts.length > 0) {
    lines.push('', 'alerts:')
    for (const alert of alerts.slice(0, 20)) lines.push(`  ${alert}`)
    if (alerts.length > 20) lines.push(`  … ${alerts.length - 20} more`)
  }
  const errors = nodes.filter(node => typeof node.lastError === 'string' && node.lastError !== '')
  if (errors.length > 0) {
    lines.push('', 'errors:')
    for (const node of errors.slice(0, 10)) lines.push(`  ${node.alias}: ${node.lastError}`)
  }
  const systems = nodes.filter(node => typeof node.os === 'string' && node.os !== '')
  if (systems.length > 0) {
    lines.push('', 'systems:')
    for (const node of systems.slice(0, 10)) lines.push(`  ${pad(node.alias, 26)} ${node.os}`)
  }
  return lines.join('\n')
}

/** The history series, downsampled so a long window stays readable. */
function renderHistory(value) {
  if (value === null || typeof value !== 'object') return 'no history'
  if (typeof value.error === 'string') return `error: ${value.error}`
  const points = Array.isArray(value.points) ? value.points : []
  const head = `${value.alias ?? '?'} · last ${value.minutes ?? '?'} min · ${points.length} sample${points.length === 1 ? '' : 's'} · store ${value.backend ?? 'unknown'}`
  if (points.length === 0) return `${head}\n${value.note ?? 'no samples'}`
  const kept = downsample(points, 24)
  const lines = [head, [
    pad('TIME', 21), pad('CPU', 7), pad('LOAD1', 7), pad('MEM', 7), pad('DISK', 7), pad('RX', 10), pad('TX', 10), 'TCP',
  ].join(' ')]
  for (const point of kept) {
    lines.push([
      pad(new Date(point.ts).toISOString().slice(0, 19).replace('T', ' '), 21),
      pad(pct(point.cpuPct), 7),
      pad(num(point.load1, 2), 7),
      pad(pct(point.memPct), 7),
      pad(pct(point.diskPct), 7),
      pad(rate(point.rxBps), 10),
      pad(rate(point.txBps), 10),
      point.tcp ?? '--',
    ].join(' '))
  }
  if (kept.length < points.length) lines.push(`(${points.length - kept.length} samples elided; each row is one of ${Math.ceil(points.length / kept.length)})`)
  return lines.join('\n')
}

/** The sweep result. */
function renderRefresh(value) {
  if (value === null || typeof value !== 'object') return 'refresh failed'
  const lines = [
    `swept ${value.total ?? 0} hosts in ${value.durationMs ?? '?'} ms · ${value.online ?? 0} online · ${value.offline ?? 0} offline · ${value.skipped ?? 0} skipped`,
    `collectedAt ${value.collectedAt === null || value.collectedAt === undefined ? 'unknown' : new Date(value.collectedAt).toISOString()}`,
  ]
  const problems = Array.isArray(value.problems) ? value.problems : []
  if (problems.length > 0) {
    lines.push('problems:')
    for (const problem of problems.slice(0, 10)) lines.push(`  ${typeof problem === 'string' ? problem : JSON.stringify(problem)}`)
    if (problems.length > 10) lines.push(`  … ${problems.length - 10} more`)
  }
  return lines.join('\n')
}

/** Even stride over the series, always keeping the newest point. */
function downsample(points, target) {
  if (points.length <= target) return points
  const stride = Math.ceil(points.length / target)
  const kept = []
  for (let index = points.length - 1; index >= 0; index -= stride) kept.push(points[index])
  return kept.reverse()
}

/** Round to `digits` places, tolerating null. */
function round(value, digits) {
  if (value === null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * A byte-per-second value on its way out of the tool result.
 *
 * `Math.round(undefined)` is NaN, and NaN survives JSON serialisation into the
 * model's context as the literal `NaN` — which then renders as `NaNKB/s`. A
 * missing counter is a missing measurement, so it travels as null instead. This
 * matters for the JSON fallback store, where an older snapshot may predate a
 * column.
 */
function wholeBytes(value) {
  return Number.isFinite(value) ? Math.round(value) : null
}

/** Right-pad to a column width, truncating rather than wrecking the table. */
function pad(value, width) {
  const string = value === null || value === undefined ? '--' : String(value)
  if (string.length === width) return string
  return string.length > width ? `${string.slice(0, width - 1)}…` : string.padEnd(width)
}

/** A percentage column. */
function pct(value) {
  return value === null || value === undefined ? '--' : `${value}%`
}

/** A fixed-place column that tolerates null. */
function num(value, digits) {
  return value === null || value === undefined ? '--' : value.toFixed(digits)
}

/** A byte-per-second column. */
function rate(bytesPerSecond) {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return '--'
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)}B/s`
  const units = ['KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}${units[unit]}`
}

/** `5d 3h` / `3h 12m` / `12m 30s`. */
function uptime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
