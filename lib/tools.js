/**
 * Agent-facing tools for the server monitor.
 *
 * Seven read-mostly tools: read the fleet, read one node's history, force a
 * sweep, read the service probes, read the alert rules and incidents, read the
 * scheduled tasks, and read one host's hardware detail. The tools deliberately
 * return the *shaped* rows the panel shows, so a model reading them and an
 * operator reading the panel never disagree about a number.
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

import { nextRun, parseCron } from './cron.js'

/**
 * Build the tool list.
 * @param deps - tool dependencies.
 * @param deps.collector - the collector owning the loop.
 * @param deps.store - the history store.
 * @param deps.services - the probe runner, when the host provides it.
 * @param deps.alerts - the alert engine, when the host provides it.
 * @returns tool objects for `ctx.tools.register`.
 */
export function makeTools(deps) {
  const { collector, store, services, alerts } = deps

  const tools = [
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

  // Probes, alerts and tasks are only readable when their engines exist. A tool
  // that exists and always answers "not available" is worse than an absent one,
  // because the model has no way to tell the two apart.
  if (services !== undefined && services !== null) tools.push(servicesTool(services))
  if (alerts !== undefined && alerts !== null) tools.push(alertsTool(store))
  tools.push(tasksTool(store))
  tools.push(hostTool({ collector, store }))

  return tools
}

/** One text content block — the only render shape these tools emit. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** The next fire time for a schedule, or null when it can never fire. */
function nextRunAt(schedule) {
  try {
    return nextRun(parseCron(schedule), Date.now())
  } catch {
    // A hand-edited expression in the table should read as "never", not take the
    // whole tool down.
    return null
  }
}

/** The probe reader. */
function servicesTool(services) {
  return {
    name: 'fleet_services',
    description: 'Read the HTTP / TCP / ICMP probes and their recent results: whether each is up right now, its latency, how many of the last samples were up, and the last error. Probes run from the DSH host, so a result describes the service as seen from here.',
    parameters: {
      filter: {
        type: 'string',
        description: 'Restrict the answer to probes that are up, down, or have never run.',
        enum: ['all', 'up', 'down', 'unknown'],
        required: false,
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(renderServices(value)),
    },
    // Reads the local store and the in-memory schedule; safe to overlap.
    isConcurrencySafe: () => true,
    async execute(args) {
      const list = services.list()
      const wanted = args?.filter ?? 'all'
      // `list()` reports the last sample as `latest` and the ring as `grid`.
      const rows = list.filter((probe) => {
        const latest = probe.latest ?? null
        if (wanted === 'all') return true
        if (wanted === 'unknown') return latest === null
        if (wanted === 'up') return latest !== null && latest.ok === true
        return latest !== null && latest.ok !== true
      })
      return {
        total: list.length,
        returned: rows.length,
        probes: rows.map((probe) => {
          const grid = Array.isArray(probe.grid) ? probe.grid : []
          const latest = probe.latest ?? null
          const latencies = grid.map((row) => row.latencyMs).filter((value) => typeof value === 'number')
          return {
            name: probe.name,
            type: probe.type,
            target: probe.target,
            intervalSec: probe.intervalSec,
            enabled: probe.enabled,
            ok: latest === null ? null : latest.ok === true,
            latencyMs: latest?.latencyMs ?? null,
            statusCode: latest?.statusCode ?? null,
            certDays: latest?.certDays ?? null,
            error: latest?.error ?? null,
            sampled: grid.length,
            upSamples: grid.filter((row) => row.ok === true).length,
            avgLatencyMs: latencies.length === 0
              ? null
              : Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length),
          }
        }),
      }
    },
  }
}

/** The alert reader: rules, plus the incidents they opened. */
function alertsTool(store) {
  return {
    name: 'fleet_alerts',
    description: 'Read the alerting rules and the incidents they have opened. Use this to answer "what is on fire" and "why did I get paged", and to see which rules exist before changing anything.',
    parameters: {
      state: {
        type: 'string',
        description: 'Only incidents in this state.',
        enum: ['all', 'firing', 'resolved'],
        required: false,
      },
      limit: {
        type: 'integer',
        description: 'How many incidents to return, newest first. Defaults to 20.',
        required: false,
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(renderAlerts(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const wanted = args?.state ?? 'all'
      const limit = Math.min(200, Math.max(1, Number(args?.limit ?? 20) || 20))
      const rules = store.listAlertRules()
      const events = store.listEvents(500)
        .filter((event) => (wanted === 'all' ? true : event.state === wanted))
        .slice(0, limit)
      return {
        rules: rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          metric: rule.metric,
          op: rule.op,
          threshold: rule.threshold,
          durationSec: rule.durationSec,
          cooldownSec: rule.cooldownSec,
          enabled: rule.enabled,
          scope: rule.scope,
        })),
        events: events.map((event) => ({
          id: event.id,
          ruleId: event.ruleId,
          alias: event.alias,
          state: event.state,
          metric: event.metric,
          startedAt: event.startedAt,
          endedAt: event.endedAt ?? null,
          peak: event.peak,
          lastValue: event.lastValue ?? null,
          message: event.message,
        })),
      }
    },
  }
}

/** The scheduled-command reader. */
function tasksTool(store) {
  return {
    name: 'fleet_tasks',
    description: 'Read the scheduled commands: their cron expression, next run, coverage, and the outcome of the last run. A task runs a shell command over SSH on every host it covers. To execute one now, use the panel — this tool only reads.',
    parameters: {
      runsFor: {
        type: 'integer',
        description: 'Return the recent runs of this task id as well.',
        required: false,
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(renderTasks(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const tasks = store.listCronTasks()
      const runsFor = Number(args?.runsFor)
      const runs = Number.isInteger(runsFor) && runsFor > 0 ? store.listCronRuns(runsFor, 20) : []
      return {
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.name,
          schedule: task.schedule,
          nextRunAt: nextRunAt(task.schedule),
          command: task.command,
          cover: task.cover,
          enabled: task.enabled,
          lastRunAt: task.lastRunAt ?? null,
          lastOk: task.lastOk ?? null,
        })),
        runs: runs.map((run) => ({
          id: run.id,
          taskId: run.taskId,
          startedAt: run.startedAt,
          durationMs: run.durationMs,
          total: run.total,
          okCount: run.okCount,
          output: run.output,
        })),
      }
    },
  }
}

/** One host in full: identity, latest metrics, hardware, and panel metadata. */
function hostTool({ collector, store }) {
  return {
    name: 'fleet_host',
    description: 'Read one host in full: its latest sample, the hardware the slow sweep found (temperature, GPU, listening ports, per-mount disk, per-NIC traffic), and the display metadata the operator attached. Use this after fleet_snapshot narrows the field to one machine.',
    parameters: {
      alias: {
        type: 'string',
        description: 'The host alias, exactly as fleet_snapshot reports it.',
        required: true,
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(renderHost(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const alias = typeof args?.alias === 'string' ? args.alias : ''
      const node = collector.snapshot().nodes.find((item) => item.alias === alias) ?? null
      if (node === null) return { alias, found: false }
      const hardware = store.hardwareFor(alias)
      const meta = store.listMeta().find((item) => item.alias === alias) ?? null
      return {
        alias,
        found: true,
        node: {
          status: node.status,
          host: node.host,
          port: node.port,
          user: node.user,
          source: node.source,
          os: node.os,
          cores: node.cores,
          cpuModel: node.cpuModel,
          cpuPct: node.cpuPct,
          load1: node.load1,
          load5: node.load5,
          load15: node.load15,
          memPct: node.mem?.pct ?? null,
          swapPct: node.swap?.pct ?? null,
          diskPct: node.disk?.pct ?? null,
          net: node.net,
          tcp: node.tcp,
          udp: node.udp,
          procs: node.procs,
          uptimeSec: node.uptimeSec,
          latencyMs: node.latencyMs,
          lastError: node.lastError ?? null,
          alerts: node.alerts ?? [],
        },
        hardware: hardware === null || hardware === undefined
          ? null
          : {
            ts: hardware.ts,
            tempMax: hardware.tempMax ?? null,
            sensors: hardware.sensors ?? [],
            gpu: hardware.gpu ?? null,
            listenPorts: hardware.listenPorts ?? null,
            listenList: hardware.listenList ?? [],
            partitions: hardware.partitions ?? [],
            nics: hardware.nics ?? [],
            error: hardware.error ?? null,
          },
        meta: meta === null
          ? null
          : {
            displayName: meta.displayName ?? null,
            groupName: meta.groupName ?? null,
            tags: meta.tags ?? [],
            note: meta.note ?? null,
            expireAt: meta.expireAt ?? null,
            price: meta.price ?? null,
            bandwidthGb: meta.bandwidthGb ?? null,
          },
      }
    },
  }
}

/** The probe table a model reads. */
function renderServices(value) {
  if (value === null || typeof value !== 'object') return 'no probes'
  const probes = Array.isArray(value.probes) ? value.probes : []
  if (probes.length === 0) {
    return value.total === 0
      ? 'no probes configured: add one in the panel (服务监控 → 添加探针)'
      : `no probe matches this filter (${value.total} configured)`
  }
  const lines = [`${value.returned}/${value.total} probes`]
  const kind = { 1: 'http', 2: 'tcp', 3: 'icmp' }
  for (const probe of probes) {
    const state = probe.ok === null ? 'never' : (probe.ok ? 'up' : 'down')
    const bits = [
      pad(state, 5),
      pad(kind[probe.type] ?? String(probe.type), 4),
      probe.target,
      probe.latencyMs === null ? '—' : `${probe.latencyMs}ms`,
      `${probe.upSamples}/${probe.sampled} up`,
    ]
    if (probe.certDays !== null && probe.certDays !== undefined) bits.push(`cert ${probe.certDays}d`)
    if (probe.enabled === false) bits.push('disabled')
    lines.push(`${pad(probe.name, 18)} ${bits.join('  ')}`)
    if (probe.error) lines.push(`  ${probe.error}`)
  }
  return lines.join('\n')
}

/** The incident list a model reads. */
function renderAlerts(value) {
  if (value === null || typeof value !== 'object') return 'no alert data'
  const rules = Array.isArray(value.rules) ? value.rules : []
  const events = Array.isArray(value.events) ? value.events : []
  const lines = [`${rules.length} rule(s), ${events.length} incident(s)`]
  for (const rule of rules) {
    const scope = rule.scope?.mode === 'include'
      ? `only ${(rule.scope.aliases ?? []).join(',')}`
      : rule.scope?.mode === 'exclude'
        ? `all but ${(rule.scope.aliases ?? []).join(',')}`
        : 'whole fleet'
    lines.push(`rule ${rule.id} ${rule.name}: ${rule.metric} ${rule.op === 'lt' ? '<' : '>'} ${rule.threshold} for ${rule.durationSec}s · cooldown ${rule.cooldownSec}s · ${scope}${rule.enabled === false ? ' · disabled' : ''}`)
  }
  if (events.length === 0) {
    lines.push('no incidents')
    return lines.join('\n')
  }
  lines.push('')
  for (const event of events) {
    const when = new Date(event.startedAt).toISOString()
    const peak = num(event.peak, 2)
    const ended = event.endedAt === null ? 'open' : `closed ${new Date(event.endedAt).toISOString()}`
    lines.push(`${pad(event.state, 8)} ${when}  ${event.alias}  rule ${event.ruleId} ${event.metric} peak ${peak}  (${ended})`)
    if (event.message) lines.push(`  ${event.message}`)
  }
  return lines.join('\n')
}

/** The task list a model reads. */
function renderTasks(value) {
  if (value === null || typeof value !== 'object') return 'no tasks'
  const tasks = Array.isArray(value.tasks) ? value.tasks : []
  const runs = Array.isArray(value.runs) ? value.runs : []
  const lines = [`${tasks.length} task(s)`]
  if (tasks.length === 0) lines.push('no scheduled tasks: add one in the panel (定时任务 → 添加任务)')
  for (const task of tasks) {
    const cover = task.cover?.mode === 'include'
      ? `only ${(task.cover.aliases ?? []).join(',')}`
      : task.cover?.mode === 'exclude'
        ? `all but ${(task.cover.aliases ?? []).join(',')}`
        : 'whole fleet'
    const next = task.nextRunAt === null || task.nextRunAt === undefined
      ? 'never'
      : new Date(task.nextRunAt).toISOString()
    const last = task.lastRunAt === null || task.lastRunAt === undefined
      ? 'never run'
      : `last ${task.lastOk === true ? 'ok' : 'failed'} at ${new Date(task.lastRunAt).toISOString()}`
    lines.push(`task ${task.id} ${task.name} · ${task.schedule} · next ${next} · ${cover} · ${last}${task.enabled === false ? ' · disabled' : ''}`)
    lines.push(`  $ ${task.command}`)
  }
  if (runs.length > 0) {
    lines.push('')
    for (const run of runs) {
      lines.push(`run ${run.id} at ${new Date(run.startedAt).toISOString()} · ${run.okCount}/${run.total} hosts ok · ${run.durationMs}ms`)
      if (run.output) lines.push(run.output.split('\n').slice(0, 6).map((line) => `  ${line}`).join('\n'))
    }
  }
  return lines.join('\n')
}

/** One host, rendered as the three blocks it came in. */
function renderHost(value) {
  if (value === null || typeof value !== 'object') return 'no host'
  if (value.found !== true) return `no host with alias "${value.alias ?? ''}"`
  const node = value.node ?? {}
  const lines = [`${value.alias} — ${node.status} · ${node.os?.name ?? 'unknown os'}${node.lastError ? ` · ${node.lastError}` : ''}`]
  lines.push(`cpu ${pct(node.cpuPct)} · load ${num(node.load1, 2)}/${num(node.load5, 2)}/${num(node.load15, 2)} · mem ${pct(node.memPct)} · disk ${pct(node.diskPct)} · swap ${pct(node.swapPct)}`)
  lines.push(`net ${rate(node.net?.rxBps)} in / ${rate(node.net?.txBps)} out · tcp ${num(node.tcp, 0)} · udp ${num(node.udp, 0)} · procs ${num(node.procs, 0)} · up ${uptime(node.uptimeSec)} · latency ${node.latencyMs ?? '—'}ms`)
  if (Array.isArray(node.alerts) && node.alerts.length > 0) lines.push(`alerting: ${node.alerts.join(', ')}`)
  const hardware = value.hardware
  if (hardware === null || hardware === undefined) {
    lines.push('', 'hardware: not collected yet (the slow sweep runs every five minutes)')
  } else if (hardware.error) {
    lines.push('', `hardware: failed — ${hardware.error}`)
  } else {
    const ports = Array.isArray(hardware.listenList) && hardware.listenList.length > 0
      ? hardware.listenList.join(',')
      : '—'
    lines.push('', `hardware: temp ${hardware.tempMax === null || hardware.tempMax === undefined ? '—' : `${Math.round(hardware.tempMax * 10) / 10}C`} · gpu ${hardware.gpu === null ? '—' : `${Math.round(hardware.gpu.util)}%`} · ports ${ports}`)
    for (const part of Array.isArray(hardware.partitions) ? hardware.partitions : []) {
      lines.push(`  ${part.mount} ${fmtSize(part.used)}/${fmtSize(part.total)}`)
    }
    for (const nic of Array.isArray(hardware.nics) ? hardware.nics : []) {
      lines.push(`  ${nic.name} ${fmtSize(nic.rxBytes)} in / ${fmtSize(nic.txBytes)} out`)
    }
  }
  const meta = value.meta
  if (meta !== null && meta !== undefined) {
    const shown = [meta.displayName, meta.groupName, (meta.tags ?? []).join(','), meta.note].filter(Boolean)
    if (shown.length > 0) lines.push('', `meta: ${shown.join(' · ')}`)
  }
  return lines.join('\n')
}

/** Bytes as a compact human string, for the hardware block. */
function fmtSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`
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
  // One decimal, because the raw value is a float: "54.78847450691375%" is what
  // a model will quote back at the operator.
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 10) / 10}%` : '--'
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
