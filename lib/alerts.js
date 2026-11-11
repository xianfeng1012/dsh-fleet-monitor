/**
 * Alert evaluation.
 *
 * The shape of this file follows Nezha's `checkTimed`, with one deliberate
 * difference forced by the transport: Nezha is pushed a state packet every three
 * seconds and decides "70% of a window failed", while this plugin polls every
 * `intervalMs` and has no sub-interval failures to count. So a rule declares a
 * duration in seconds, and the engine converts it to a number of consecutive
 * rounds. `durationSec` stays the semantic unit — the settings page shows what
 * that means at the current interval — because it is what an operator thinks in.
 */

import { sendToChannels } from './notify.js'

/**
 * Metric readers.
 *
 * Every reader may return `null`, and `null` means "this round has no reading"
 * — a host without swap, a GPU-less machine, a sweep where SSH timed out. It
 * never means zero: treating a missing reading as zero triggered a notification
 * on every SSH failure and resolved on every recovery.
 */
export const METRICS = {
  cpu: (node) => numberOrNull(node.cpuPct),
  memory: (node) => numberOrNull(node.mem?.pct),
  swap: (node) => {
    const total = node.swap?.total
    const used = node.swap?.used
    return Number.isFinite(total) && total > 0 && Number.isFinite(used) ? (used / total) * 100 : null
  },
  disk: (node) => numberOrNull(node.disk?.pct),
  load1: (node) => numberOrNull(node.load?.[0]),
  load5: (node) => numberOrNull(node.load?.[1]),
  load15: (node) => numberOrNull(node.load?.[2]),
  net_in_speed: (node) => numberOrNull(node.net?.rxBps),
  net_out_speed: (node) => numberOrNull(node.net?.txBps),
  net_all_speed: (node) => {
    const rx = node.net?.rxBps
    const tx = node.net?.txBps
    return Number.isFinite(rx) && Number.isFinite(tx) ? rx + tx : null
  },
  tcp_conn_count: (node) => numberOrNull(node.conn?.tcp),
  udp_conn_count: (node) => numberOrNull(node.conn?.udp),
  process_count: (node) => numberOrNull(node.procs),
  temperature_max: (node) => numberOrNull(node.tempMax),
  gpu: (node) => numberOrNull(node.gpuUtil),
  offline: (node) => (node.status === 'online' ? 0 : 1),
  // Transfer rules are monthly by default: the daily rollup already holds the
  // bytes, and a rule that says "2 TB per month" is the one operators actually
  // write. The per-cycle variants Nezha offers need a cycle column on the rule,
  // which this table does not carry.
  transfer_in: (node, transfers) => gigabytes(transfers?.get(node.alias)?.rx),
  transfer_out: (node, transfers) => gigabytes(transfers?.get(node.alias)?.tx),
  transfer_all: (node, transfers) => gigabytes((transfers?.get(node.alias)?.rx ?? 0) + (transfers?.get(node.alias)?.tx ?? 0)),
}

/** Metric names the API will accept, in the order the editor lists them. */
export const METRIC_NAMES = Object.keys(METRICS)

/** Metrics that read a byte counter and are compared in gigabytes. */
const GIGABYTE_METRICS = new Set(['transfer_in', 'transfer_out', 'transfer_all'])

/** A finite number, or null — never NaN, never zero-by-accident. */
function numberOrNull(value) {
  return Number.isFinite(value) ? value : null
}

/** Bytes as gigabytes, or null when nothing was measured. */
function gigabytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  return bytes / 1024 ** 3
}

/**
 * Whether one host belongs to a rule's scope.
 *
 * `mode` is `all`, `include` or `exclude`; an empty alias list under `include`
 * matches nothing, which is what an operator means by "only these" before they
 * have listed any.
 *
 * @param scope - the rule's parsed scope.
 * @param alias - the host alias.
 * @returns whether the rule applies.
 */
export function inScope(scope, alias) {
  const mode = scope?.mode ?? 'all'
  const aliases = Array.isArray(scope?.aliases) ? scope.aliases : []
  if (mode === 'all') return true
  if (mode === 'include') return aliases.includes(alias)
  if (mode === 'exclude') return !aliases.includes(alias)
  return true
}

/**
 * Convert a rule's duration into consecutive rounds at the current interval.
 *
 * Offline is floored at two rounds: one missed sweep is a flaky network, two in
 * a row is a machine that is actually down, and a single-round offline rule
 * would page on every dropped SSH connection.
 *
 * @param rule - the rule.
 * @param intervalMs - the fast sweep interval.
 * @returns the number of consecutive breaching rounds required.
 */
export function roundsFor(rule, intervalMs) {
  const floor = rule.metric === 'offline' ? 2 : 1
  const safeInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000
  return Math.max(floor, Math.round((rule.durationSec ?? 180) * 1000 / safeInterval))
}

/** One line describing why an event fired, used for the stored message and notifications. */
export function describeBreach(rule, node, value) {
  if (rule.metric === 'offline') return `${node.alias} is ${node.status ?? 'unknown'}`
  const rendered = value === null ? 'n/a' : String(Math.round(value * 100) / 100)
  const comparison = rule.op === 'lt' ? '<' : '>'
  return `${node.alias} ${rule.metric} ${rendered} ${comparison} ${rule.threshold}`
}

/**
 * Read one metric for one node.
 *
 * @param metric - a key of {@link METRICS}.
 * @param node - an API-shaped node.
 * @param transfers - optional `Map<alias, {rx, tx}>` of monthly byte totals.
 * @returns the value, or `null` when this round has no reading.
 */
export function metricValue(metric, node, transfers) {
  const reader = METRICS[metric]
  if (reader === undefined) return null
  return reader(node, transfers ?? new Map())
}

/**
 * The evaluation loop.
 *
 * State lives in memory and is mirrored to `alert_event` so a restart resumes
 * firing instead of re-notifying from scratch. Evaluation is driven by the
 * collector: one call per sweep, never on a timer of its own, so a rule can
 * never see a snapshot older than the sweep being evaluated.
 */
export class AlertEngine {
  /**
   * @param options - engine inputs.
   * @param options.store - the history store.
   * @param options.config - the live plugin config (or a getter for it).
   * @param options.emit - called after events change, to refresh subscribers.
   */
  constructor({ store, config, emit }) {
    this.store = store
    this.getConfig = typeof config === 'function' ? config : () => config ?? {}
    this.emit = emit ?? (() => {})
    /** @type {Map<string, {consecutive: number, state: string, eventId: number|null, peak: number, lastNotifiedAt: number, noData: boolean}>} */
    this.state = new Map()
    /** `key -> epoch ms` until which notifications are suppressed but events still record. */
    this.silenced = new Map()
    this.rules = []
    this.started = false
  }

  /** Load rules and replay open events. Idempotent. */
  start() {
    if (this.started) return
    this.started = true
    this.reload()
    for (const event of this.store.openEvents()) {
      const key = `${event.ruleId}:${event.alias}`
      this.state.set(key, {
        consecutive: 0,
        state: 'firing',
        eventId: event.id,
        peak: event.peak ?? 0,
        lastNotifiedAt: 0,
        noData: false,
      })
    }
  }

  /** Re-read the rule table, dropping state for rules that no longer exist. */
  reload() {
    this.rules = this.store.listAlertRules()
    const alive = new Set(this.rules.map((rule) => rule.id))
    for (const key of [...this.state.keys()]) {
      const ruleId = Number(key.slice(0, key.indexOf(':')))
      if (!alive.has(ruleId)) this.state.delete(key)
    }
  }

  dispose() {
    this.state.clear()
    this.silenced.clear()
    this.rules = []
    this.started = false
  }

  /**
   * Suppress notifications for one rule (optionally one host) for a while.
   * Events keep recording: silencing a page is not the same as pretending the
   * condition is gone.
   *
   * @param ruleId - the rule, or `null` for every rule.
   * @param alias - the host, or `null` for every host.
   * @param minutes - how long, at least one minute.
   */
  silence(ruleId, alias, minutes) {
    const until = Date.now() + Math.max(1, minutes) * 60_000
    this.silenced.set(`${ruleId ?? '*'}:${alias ?? '*'}`, until)
    return until
  }

  /** Whether notifications are currently suppressed for this rule and host. */
  isSilenced(ruleId, alias) {
    const now = Date.now()
    for (const key of [`${ruleId}:${alias}`, `${ruleId}:*`, `*:${alias}`, `*:*`]) {
      const until = this.silenced.get(key)
      if (until === undefined) continue
      if (until > now) return true
      this.silenced.delete(key)
    }
    return false
  }

  /** Monthly transfer totals per alias, read from the daily rollup. */
  monthlyTransfers(now) {
    const out = new Map()
    const firstDay = `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, '0')}-01`
    for (const row of this.store.dailyStats(firstDay)) {
      const current = out.get(row.alias) ?? { rx: 0, tx: 0 }
      current.rx += row.rxBytes ?? 0
      current.tx += row.txBytes ?? 0
      out.set(row.alias, current)
    }
    return out
  }

  /**
   * Evaluate every enabled rule against one snapshot.
   *
   * @param nodes - API-shaped nodes from the sweep that just finished.
   * @returns a summary of what was opened, closed and sent.
   */
  async evaluate(nodes) {
    if (!this.started) return { opened: 0, closed: 0, sent: 0, failed: 0, errors: [] }
    const config = this.getConfig()
    const intervalMs = config.intervalMs ?? 30_000
    const transfers = this.monthlyTransfers(Date.now())
    const pending = []
    let opened = 0
    let closed = 0

    for (const rule of this.rules) {
      if (rule.enabled === false) continue
      const needed = roundsFor(rule, intervalMs)
      for (const node of nodes) {
        if (!inScope(rule.scope, node.alias)) continue
        const key = `${rule.id}:${node.alias}`
        const state = this.state.get(key) ?? { consecutive: 0, state: 'idle', eventId: null, peak: 0, lastNotifiedAt: 0, noData: false }
        const value = metricValue(rule.metric, node, transfers)

        // No reading this round. Freeze: neither accumulate nor reset, and never
        // resolve a firing event on the strength of a missing measurement.
        if (value === null) {
          state.noData = true
          this.state.set(key, state)
          continue
        }
        state.noData = false

        const breach = rule.metric === 'offline'
          ? value === 1
          : (rule.op === 'lt' ? value < rule.threshold : value > rule.threshold)

        if (breach) {
          state.consecutive += 1
          state.peak = Math.max(state.peak, value)
        } else {
          state.consecutive = 0
        }

        if (state.state !== 'firing' && state.consecutive >= needed) {
          const message = describeBreach(rule, node, value)
          state.state = 'firing'
          state.eventId = this.store.openEvent(rule, node.alias, value, state.peak, message)
          opened += 1
          // Cooldown applies only here, at the idle → firing edge. While the rule
          // stays firing this branch never runs, so a sustained breach notifies
          // once; what the cooldown actually suppresses is a flap that opens,
          // resolves and re-opens within the window.
          const cooldownMs = (rule.cooldownSec ?? 1800) * 1000
          if (Date.now() - state.lastNotifiedAt >= cooldownMs) {
            state.lastNotifiedAt = Date.now()
            pending.push({ rule, node, value, state: 'firing', message })
          }
        } else if (state.state === 'firing' && state.consecutive === 0) {
          const message = describeBreach(rule, node, value)
          this.store.closeEvent(state.eventId, value)
          state.state = 'idle'
          state.eventId = null
          state.peak = 0
          closed += 1
          // Recovery is never held back by a cooldown: a stale "still broken"
          // message is worse than a slightly chatty one.
          pending.push({ rule, node, value, state: 'resolved', message })
        }

        this.state.set(key, state)
      }
    }

    const delivery = await this.flush(pending)
    if (opened > 0 || closed > 0) this.emit()
    return { opened, closed, ...delivery }
  }

  /**
   * Send the notifications one evaluation produced.
   *
   * More than {@link MERGE_LIMIT} messages would turn one bad sweep into a page
   * storm, so the tail is collapsed into a single digest delivered to the first
   * group involved.
   */
  async flush(pending) {
    const deliverable = pending.filter((item) => !this.isSilenced(item.rule.id, item.node.alias))
    if (deliverable.length === 0) return { sent: 0, failed: 0, errors: [] }

    const MERGE_LIMIT = 5
    const batches = deliverable.length <= MERGE_LIMIT
      ? deliverable.map((item) => ({ channels: this.store.channelsForGroup(item.rule.notifyGroupId), context: item }))
      : buildDigest(deliverable, MERGE_LIMIT, this.store)

    let sent = 0
    let failed = 0
    const errors = []
    for (const batch of batches) {
      if (batch.channels.length === 0) continue
      const result = await sendToChannels(batch.channels, batch.context)
      sent += result.sent
      failed += result.failed
      errors.push(...result.errors)
    }
    return { sent, failed, errors }
  }
}

/**
 * Split an oversized batch into individual messages plus one summary.
 *
 * The summary keeps the same placeholder vocabulary, so a channel template that
 * renders `#MESSAGE#` prints the whole list without knowing it is a digest.
 */
function buildDigest(items, limit, store) {
  const head = items.slice(0, limit - 1)
  const tail = items.slice(limit - 1)
  const batches = head.map((item) => ({ channels: store.channelsForGroup(item.rule.notifyGroupId), context: item }))
  const summaryContext = {
    rule: tail[0].rule,
    node: tail[0].node,
    value: tail[0].value,
    state: tail[0].state,
    message: `${tail.length} more events: ${tail.map((item) => item.message).join('; ')}`,
  }
  batches.push({ channels: store.channelsForGroup(tail[0].rule.notifyGroupId), context: summaryContext })
  return batches
}

/** Re-exported so the routes can compare units without importing the table twice. */
export { GIGABYTE_METRICS }
