/**
 * Service probes: HTTP, TCP and ICMP.
 *
 * These run on the DSH host, not on the monitored machines. That is deliberate:
 * it lets one panel watch an HTTP endpoint, a database port and a router that
 * has no SSH at all, and it keeps working when a host's SSH credentials expire.
 * The cost is that the probe sees the target from the host's network position,
 * so "port 5432 is closed" means closed from here.
 *
 * @module dsh-fleet-monitor/services
 */

import net from 'node:net'
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'

import { PROBE_GRID } from './store.js'

/** HTTP(S) endpoint: status code, optional body keyword, optional TLS expiry. */
export const PROBE_HTTP = 1
/** Raw TCP connect. Answers "is something listening", not "is it healthy". */
export const PROBE_TCP = 2
/** ICMP echo. The only probe that needs a system binary. */
export const PROBE_ICMP = 3

/** Minimum spacing between two TLS expiry lookups of the same probe. */
const CERT_INTERVAL_MS = 6 * 60 * 60 * 1000

/** A probe interval below this would hammer the target and the log files. */
const INTERVAL_FLOOR_MS = 10_000

const USER_AGENT = 'dsh-fleet-monitor/0.2'

/**
 * Match an HTTP status against the operator's expectation syntax.
 *
 * Supported: `"200"` exact, `"2xx"` class, `"200,204"` list, `"/^2\\d\\d$/"` regex.
 * Anything unparsable is a miss rather than a crash — the operator typed it.
 *
 * @param actual - the status code that came back.
 * @param expect - the expectation string.
 * @returns whether the status satisfies the expectation.
 */
export function matchStatus(actual, expect) {
  const spec = String(expect ?? '').trim()
  if (spec === '') return actual < 400
  if (spec.startsWith('/')) {
    const end = spec.lastIndexOf('/')
    if (end <= 0) return false
    try {
      return new RegExp(spec.slice(1, end), spec.slice(end + 1)).test(String(actual))
    } catch {
      return false
    }
  }
  return spec.split(',').some((part) => {
    const token = part.trim().toLowerCase()
    if (token === '') return false
    if (/^\dxx$/.test(token)) return Math.floor(actual / 100) === Number(token[0])
    return Number(token) === Number(actual)
  })
}

/**
 * Days until the certificate of `hostname` expires.
 *
 * `rejectUnauthorized: false` is required, not sloppy: a self-signed certificate
 * that fails verification never reaches `getPeerCertificate`, so expiry
 * monitoring would be blind on exactly the internal services that need it most.
 * `servername` is required too — without SNI a CDN sharing one address answers
 * with its default certificate and the countdown tracks the wrong certificate.
 *
 * @param hostname - the host whose certificate to read.
 * @param timeoutMs - connect budget.
 * @returns days remaining, `0` when already expired, `null` when unreadable.
 */
export function certDaysLeft(hostname, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let request
    try {
      request = httpsRequest(
        {
          hostname,
          port: 443,
          path: '/',
          method: 'HEAD',
          rejectUnauthorized: false,
          servername: hostname,
          timeout: timeoutMs,
        },
        (response) => {
          const certificate = response.socket?.getPeerCertificate?.()
          response.resume()
          request.destroy()
          const expiresAt = Date.parse(certificate?.valid_to ?? '')
          if (!Number.isFinite(expiresAt)) {
            finish(null)
            return
          }
          const days = Math.floor((expiresAt - Date.now()) / 86_400_000)
          finish(days < 0 ? 0 : days)
        },
      )
    } catch {
      finish(null)
      return
    }
    request.on('timeout', () => {
      request.destroy()
      finish(null)
    })
    request.on('error', () => finish(null))
    request.end()
  })
}

/** Turn a thrown error into one line an operator can act on. */
function describeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed out'
  const code = error?.cause?.code ?? error?.code
  if (typeof code === 'string' && code !== '') return code
  return error?.message ?? String(error)
}

/** Read a `host:port` or scheme-prefixed target into its parts. */
function parseSocketTarget(target) {
  const text = String(target ?? '').trim()
  if (text.includes('://')) {
    const url = new URL(text)
    return { host: url.hostname, port: Number(url.port || '0') }
  }
  const cut = text.lastIndexOf(':')
  if (cut === -1) return { host: text, port: 0 }
  return { host: text.slice(0, cut), port: Number(text.slice(cut + 1)) }
}

/** Probe an HTTP endpoint. Redirects are not followed: the 3xx is the answer. */
/**
 * One HTTP attempt. Throws nothing: a failed request is a measurement, and the
 * caller decides whether it counts as a breach.
 */
async function probeHttpOnce(probe) {
  const started = performance.now()
  const response = await fetch(probe.target, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(probe.timeoutMs),
    headers: { 'user-agent': USER_AGENT },
  })
  const latencyMs = Math.round(performance.now() - started)
  let ok = matchStatus(response.status, probe.expectStatus ?? '')
  let error = null
  if (!ok) {
    error = `status ${response.status} did not match ${probe.expectStatus ?? '< 400'}`
  } else if (probe.expectKeyword) {
    const body = await response.text()
    if (!body.includes(probe.expectKeyword)) {
      ok = false
      error = `body did not contain "${probe.expectKeyword}"`
    }
  } else {
    // Drain so the socket can be reused instead of lingering until GC.
    await response.arrayBuffer().catch(() => {})
  }
  return { ok, latencyMs, statusCode: response.status, error }
}

/**
 * HTTP probe with one retry on a connection-level failure.
 *
 * A pooled socket that the peer closed between requests looks exactly like a
 * dead service on the first attempt, and paging someone because a keep-alive
 * connection expired is the fastest way to make them ignore the pager. A real
 * outage fails both attempts; a stale socket fails only the first.
 */
async function probeHttp(probe) {
  const started = performance.now()
  try {
    return await probeHttpOnce(probe)
  } catch (first) {
    if (isAbortError(first)) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), statusCode: null, error: describeError(first) }
    }
    try {
      return await probeHttpOnce(probe)
    } catch (second) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        statusCode: null,
        error: describeError(second),
      }
    }
  }
}

/** A timeout is an answer, not a stale socket, so it is never retried. */
function isAbortError(error) {
  return error !== null && typeof error === 'object' && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/** Probe whether anything accepts a TCP connection. */
function probeTcp(probe) {
  return new Promise((resolve) => {
    const { host, port } = parseSocketTarget(probe.target)
    if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      resolve({ ok: false, latencyMs: null, statusCode: null, error: `target must be host:port, got ${probe.target}` })
      return
    }
    const started = Date.now()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let socket
    try {
      socket = net.createConnection({ host, port })
    } catch (error) {
      finish({ ok: false, latencyMs: null, statusCode: null, error: describeError(error) })
      return
    }
    const timer = setTimeout(() => {
      socket.destroy()
      finish({ ok: false, latencyMs: null, statusCode: null, error: `no connection within ${probe.timeoutMs} ms` })
    }, probe.timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      const latencyMs = Date.now() - started
      socket.end()
      finish({ ok: true, latencyMs, statusCode: null, error: null })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.destroy()
      finish({ ok: false, latencyMs: null, statusCode: null, error: describeError(error) })
    })
  })
}

/** Probe reachability with the system `ping` binary. */
function probeIcmp(probe) {
  const host = String(probe.target ?? '').replace(/^icmp:\/\//, '').trim()
  const windows = process.platform === 'win32'
  const args = windows
    ? ['-n', '1', '-w', String(probe.timeoutMs), host]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(probe.timeoutMs / 1000))), host]
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn('ping', args, { windowsHide: true })
    } catch (error) {
      finish({ ok: false, latencyMs: null, statusCode: null, error: describeError(error) })
      return
    }
    let output = ''
    // ping enforces its own timeout; this is only a backstop for a wedged process.
    const backstop = setTimeout(() => {
      child.kill()
      finish({ ok: false, latencyMs: null, statusCode: null, error: `no reply within ${probe.timeoutMs} ms` })
    }, probe.timeoutMs + 3000)
    child.stdout?.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', (error) => {
      clearTimeout(backstop)
      finish({ ok: false, latencyMs: null, statusCode: null, error: describeError(error) })
    })
    child.on('close', (code) => {
      clearTimeout(backstop)
      if (code !== 0) {
        finish({ ok: false, latencyMs: null, statusCode: null, error: `ping exited with ${code}` })
        return
      }
      // Windows prints `时间<1ms` / `time=12ms`; both shapes carry `=` or `<`.
      const match = /[=<]\s*([\d.]+)\s*ms/.exec(output)
      const latencyMs = match === null ? null : Math.round(Number(match[1]))
      finish({ ok: true, latencyMs, statusCode: null, error: null })
    })
  })
}

/**
 * Run the probe matching `probe.type`.
 *
 * @param probe - a decoded probe row.
 * @returns `{ok, latencyMs, statusCode, error}` and nothing else; persistence is
 *   the caller's job so this stays testable without a store.
 */
export async function runProbeOnce(probe) {
  if (probe.type === PROBE_HTTP) return probeHttp(probe)
  if (probe.type === PROBE_TCP) return probeTcp(probe)
  if (probe.type === PROBE_ICMP) return probeIcmp(probe)
  return { ok: false, latencyMs: null, statusCode: null, error: `unknown probe type ${probe.type}` }
}

/**
 * Schedules every configured probe on its own timer and stores the results.
 *
 * One timer per probe rather than one global tick: a 30-second endpoint and a
 * 10-minute one should not force each other's cadence, and a slow HTTP probe
 * must not delay an ICMP ping.
 */
export class ServiceMonitor {
  /**
   * @param options - wiring.
   * @param options.store - the history store.
   * @param options.emit - called after a result lands so the panel can repaint.
   */
  constructor({ store, emit = () => {} } = {}) {
    this.store = store
    this.emit = emit
    this.timers = new Map()
    this.running = new Set()
    this.certCheckedAt = new Map()
    this.started = false
  }

  /** Every probe with its newest measurement and its 30-cell grid. */
  list() {
    const latest = this.store.latestProbeResults()
    return this.store.listProbes().map((probe) => ({
      ...probe,
      latest: latest.get(probe.id) ?? null,
      grid: this.store.probeResults(probe.id, PROBE_GRID),
    }))
  }

  /** Begin scheduling every enabled probe. Safe to call twice. */
  start() {
    if (this.started) return
    this.started = true
    for (const probe of this.store.listProbes()) this.schedule(probe)
  }

  /**
   * Arm the next run of one probe.
   *
   * The first delay is spread across the first third of the interval so a panel
   * with twenty probes does not fire all twenty in the same second after a
   * restart.
   *
   * @param probe - the probe to schedule.
   */
  schedule(probe) {
    if (!this.started || probe.enabled === false) return
    const interval = Math.max(INTERVAL_FLOOR_MS, (probe.intervalSec ?? 60) * 1000)
    const delay = Math.round(Math.random() * interval * 0.3)
    const timer = setTimeout(() => {
      this.timers.delete(probe.id)
      void this.runProbe(probe)
        .catch(() => {})
        .finally(() => {
          // Re-read instead of reusing `probe`: the operator may have changed the
          // interval or disabled it while this run was in flight.
          const current = this.store.listProbes().find(candidate => candidate.id === probe.id)
          if (current !== undefined) this.schedule(current)
        })
    }, delay)
    timer.unref?.()
    this.timers.set(probe.id, timer)
  }

  /** Drop every timer; results already stored stay. */
  dispose() {
    this.started = false
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** Pick up probe edits without restarting the plugin. */
  reload() {
    // A monitor that was never started must not start here: the panel saves
    // probes before the plugin's start effect has run, and arming timers from a
    // route handler would outlive the request that created them.
    if (!this.started) return
    this.dispose()
    this.started = true
    for (const probe of this.store.listProbes()) this.schedule(probe)
  }

  /**
   * Run one probe now, store the result, and tell the panel.
   *
   * @param probe - the probe to run.
   * @returns the stored measurement, or `null` when a run was already in flight.
   */
  async runProbe(probe) {
    if (this.running.has(probe.id)) return null
    this.running.add(probe.id)
    try {
      const measurement = await runProbeOnce(probe)
      const ts = Date.now()
      let certDays = null
      if (probe.type === PROBE_HTTP && String(probe.target).startsWith('https:')) {
        const checkedAt = this.certCheckedAt.get(probe.id) ?? 0
        if (ts - checkedAt >= CERT_INTERVAL_MS) {
          certDays = await certDaysLeft(new URL(probe.target).hostname, probe.timeoutMs)
          this.certCheckedAt.set(probe.id, ts)
        } else {
          certDays = this.store.latestProbeResults().get(probe.id)?.certDays ?? null
        }
      }
      const stored = { ts, ...measurement, certDays }
      this.store.insertProbeResult(probe.id, stored)
      this.emit()
      return stored
    } finally {
      this.running.delete(probe.id)
    }
  }
}
