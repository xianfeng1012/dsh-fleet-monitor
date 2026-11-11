/**
 * Scheduled commands, run over SSH on the hosts the operator picked.
 *
 * Two properties matter more than anything else here:
 *
 * 1. A task never overlaps with itself or with another task. Operators schedule
 *    backups and restarts; firing a second copy of the same restart because the
 *    first one was slow is how a fleet goes down.
 * 2. Output is kept per host, tail-truncated, so the panel can answer "which
 *    machine failed" instead of showing one blended blob.
 *
 * The scheduler is a single timer chain rather than one timer per task: the tasks
 * live in a table that can change at any moment, and one chain means `reload()`
 * only has to clear a single handle.
 */

import { nextRun, parseCron } from './cron.js'
import { resolveAuth } from './hosts.js'

/** Per-host tail kept in `cron_run.output` before the whole field is clipped. */
const HOST_TAIL_BYTES = 1024
/** Whole-field cap: twenty hosts of tails would otherwise be 20 KB per run. */
const OUTPUT_CAP_BYTES = 8192
/** Targets dialled at once, independent of the collector's own gate. */
const TASK_CONCURRENCY = 4
/** A scheduled run that is overdue by more than this is skipped, not replayed. */
const MAX_LATENESS_MS = 60 * 60 * 1000

function tail(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  return `${value.slice(0, 1)}${value.slice(value.length - limit + 1)}`
}

/**
 * Join the per-host results into the single column the table stores.
 *
 * Every host appears, not just the failing ones: after a partial failure the
 * first question is "and which ones did work", and a log that only lists
 * failures cannot answer it.
 *
 * The clip is applied per host, not to the finished string: cutting a joined
 * blob at 8 KB would silently drop the last few hosts, and those are exactly the
 * ones an operator scrolled to the bottom to find. Hosts that do not fit are
 * named in the trailer instead.
 */
export function summariseOutput(results) {
  const parts = []
  const omitted = []
  let size = 0
  const budget = OUTPUT_CAP_BYTES - 64
  for (const result of results) {
    const label = result.error === undefined
      ? `--- ${result.alias} (exit ${result.exitCode ?? '?'}) ---`
      : `--- ${result.alias} (${result.error}) ---`
    const body = tail(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), HOST_TAIL_BYTES)
    const block = `${label}\n${body}`
    if (size + block.length + 1 > budget) {
      omitted.push(result.alias)
      continue
    }
    parts.push(block)
    size += block.length + 1
  }
  if (omitted.length > 0) {
    parts.push(`[truncated] ${omitted.length} more host(s): ${omitted.join(', ')}`)
  }
  return parts.join('\n')
}

/** Which hosts a task covers, using the same scope shape as alert rules. */
export function resolveCover(cover, hosts) {
  const mode = cover?.mode ?? 'all'
  const aliases = Array.isArray(cover?.aliases) ? cover.aliases : []
  if (mode === 'all') return hosts.slice()
  if (mode === 'include') return hosts.filter((host) => aliases.includes(host.alias))
  return hosts.filter((host) => !aliases.includes(host.alias))
}

export class TaskRunner {
  /**
   * @param {object} deps
   * @param {object} deps.store - persistence for tasks and runs
   * @param {object} deps.pool - SSH pool (`run(host, config, command, timeoutMs)`)
   * @param {object} deps.collector - source of the current host list
   * @param {() => object} deps.getConfig - live plugin config
   * @param {object} [deps.notify] - `{ sendToChannels(channels, context) }`
   * @param {() => void} [deps.emit] - wake the panel after a run
   */
  constructor({ store, pool, collector, getConfig, notify = null, emit = () => {} }) {
    this.store = store
    this.pool = pool
    this.collector = collector
    this.getConfig = getConfig
    this.notify = notify
    this.emit = emit
    this.timer = null
    this.started = false
    /** Set while any task is executing — the serialisation gate. */
    this.running = false
    this.parsed = new Map()
  }

  start() {
    if (this.started) return
    this.started = true
    this.reload()
  }

  dispose() {
    this.started = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Re-read the table and re-arm the chain. Safe to call from a request. */
  reload() {
    this.parsed.clear()
    for (const task of this.store.listCronTasks()) {
      if (!task.enabled) continue
      try {
        this.parsed.set(task.id, parseCron(task.schedule))
      } catch {
        // A row edited into an invalid expression is skipped rather than
        // breaking every other task's schedule.
      }
    }
    if (!this.started) return
    this.scheduleNext()
  }

  /** The soonest pending run across all enabled tasks. */
  nextAt(from = Date.now()) {
    let soonest = null
    for (const [taskId, parsed] of this.parsed) {
      const at = nextRun(parsed, from)
      if (at === null) continue
      if (soonest === null || at < soonest.at) soonest = { taskId, at }
    }
    return soonest
  }

  scheduleNext() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.started) return
    const next = this.nextAt()
    if (next === null) return
    // setTimeout overflows past ~24.8 days; chain shorter hops until we get there.
    const delay = Math.min(Math.max(0, next.at - Date.now()), 60 * 60 * 1000)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick(next.taskId, next.at)
    }, delay)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  async tick(taskId, scheduledAt) {
    const now = Date.now()
    const task = this.store.listCronTasks().find((item) => item.id === taskId)
    if (task !== undefined && task.enabled) {
      // A machine that was suspended for a day must not wake up and run every
      // missed occurrence back to back; only the latest one is meaningful.
      if (now - scheduledAt <= MAX_LATENESS_MS) {
        await this.runTask(task, { manual: false })
      }
    }
    this.scheduleNext()
  }

  /**
   * Execute one task now.
   *
   * @returns the recorded run, or `{ skipped }` when another task holds the gate.
   */
  async runTask(task, { manual = false } = {}) {
    if (this.running) return { skipped: 'another task is already running' }
    this.running = true
    const started = Date.now()
    try {
      const config = this.getConfig()
      const hosts = resolveCover(task.cover, this.collector.hosts ?? [])
      const timeoutMs = Math.max(1000, task.timeoutMs ?? 60_000)
      const results = new Array(hosts.length)
      let cursor = 0
      const worker = async () => {
        while (cursor < hosts.length) {
          const index = cursor
          cursor += 1
          const host = hosts[index]
          if (host.proxyJump !== undefined && host.proxyJump.length > 0) {
            results[index] = { alias: host.alias, ok: false, error: 'proxy jump not supported', stdout: '', stderr: '' }
            continue
          }
          const authConfig = resolveAuth(host, {
            connectTimeoutMs: config.connectTimeoutMs,
            agentSocket: config.agentSocket === '' ? undefined : config.agentSocket,
          })
          try {
            // The pool reports an SSH exit status as `code`; `null` means the
            // channel closed without one (timeout, transport failure).
            const result = await this.pool.run(host, authConfig, task.command, timeoutMs)
            results[index] = {
              alias: host.alias,
              ok: result.error === undefined && result.code === 0,
              exitCode: result.code ?? null,
              stdout: result.stdout ?? '',
              stderr: result.stderr ?? '',
              error: result.error,
              timedOut: result.timedOut === true,
            }
          } catch (error) {
            // The pool already retried once; a throw here is a programming error
            // or a dead pool. Record it against the host instead of aborting the
            // remaining targets.
            results[index] = {
              alias: host.alias,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              stdout: '',
              stderr: '',
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(TASK_CONCURRENCY, hosts.length) }, worker))

      const filled = results.filter((item) => item !== undefined)
      const okCount = filled.filter((item) => item.ok).length
      const run = {
        ts: started,
        total: filled.length,
        okCount,
        durationMs: Date.now() - started,
        output: summariseOutput(filled),
      }
      const runId = this.store.insertCronRun(task.id, run)
      this.store.markCronRun(task.id, started, okCount === filled.length && filled.length > 0)

      if (task.notifyGroupId !== null && task.notifyGroupId !== undefined && this.notify !== null) {
        void this.notifyTask(task, filled, manual)
      }
      this.emit()
      return { id: runId, ...run, ok: okCount === filled.length && filled.length > 0 }
    } finally {
      this.running = false
    }
  }

  async notifyTask(task, results, manual) {
    try {
      const channels = this.store.channelsForGroup(task.notifyGroupId)
      if (channels.length === 0) return
      const failed = results.filter((item) => !item.ok).map((item) => item.alias)
      const succeeded = results.length - failed.length
      await this.notify.sendToChannels(channels, {
        // The context shape mirrors an alert event so a task uses the same
        // template placeholders the operator already learned.
        node: { alias: 'dsh-fleet-monitor', name: 'dsh-fleet-monitor', host: '127.0.0.1' },
        rule: { name: task.name, metric: 'task', threshold: results.length, durationSec: 0 },
        value: succeeded,
        state: failed.length === 0 ? 'resolved' : 'firing',
        message: `${manual ? '[手动] ' : ''}task ${task.name}: ${succeeded}/${results.length} ok` +
          (failed.length === 0 ? '' : `, failed: ${failed.join(', ')}`),
      })
    } catch {
      // A notification failure must not change the run's recorded outcome.
    }
  }
}
