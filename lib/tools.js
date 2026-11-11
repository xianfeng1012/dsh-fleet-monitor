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
 * object either way.
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
            rxBps: node.net.rxBps === null ? null : Math.round(node.net.rxBps),
            txBps: node.net.txBps === null ? null : Math.round(node.net.txBps),
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
            rxBps: row.rx_bps === null ? null : Math.round(row.rx_bps),
            txBps: row.tx_bps === null ? null : Math.round(row.tx_bps),
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

/** Round to `digits` places, tolerating null. */
function round(value, digits) {
  if (value === null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
