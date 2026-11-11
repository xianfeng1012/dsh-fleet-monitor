/**
 * SSH transport: one persistent connection per host, reused across polls.
 *
 * Polling 30 machines every 30 seconds must not open 30 handshakes every 30
 * seconds — a full key exchange costs more than the collection itself and looks
 * like a brute-force attempt in the target's auth log. Connections are pooled by
 * alias, kept alive with SSH keepalives, and dropped after an idle period.
 *
 * The pool also owns the two limits that keep a big inventory from hurting the
 * host: a global concurrency cap and a per-exec timeout.
 *
 * @module dsh-fleet-monitor/pool
 */

import { Client } from 'ssh2'
import { PROBE_SCRIPT, parseProbe } from './probe.js'

/** Close a pooled connection after this long without a poll. */
const IDLE_CLOSE_MS = 5 * 60_000

/**
 * One pooled connection.
 *
 * `stream` errors and `conn` errors are both funnelled into the pending exec's
 * callback: ssh2 reports a channel failure on the stream and a transport
 * failure on the client, and a poll must not hang waiting on the one that did
 * not fire.
 */
class PooledConnection {
  /** @param config - ssh2 ConnectConfig. */
  constructor(config) {
    this.config = config
    this.conn = null
    this.ready = null
    this.lastUsed = Date.now()
    this.closed = false
  }

  /** Open (or reuse) the transport. @returns a ready ssh2 Client. */
  async open() {
    if (this.conn !== null && this.ready !== null) {
      try {
        await this.ready
        this.lastUsed = Date.now()
        return this.conn
      } catch {
        this.destroy()
      }
    }
    const conn = new Client()
    this.conn = conn
    this.lastError = undefined
    // `ssh2.Client` is an EventEmitter, and Node *throws* when an 'error' event
    // has no listener. A target that drops the connection before the handshake —
    // a closed port, a bastion that refuses the key, a host that rebooted
    // mid-sweep — would then take down the whole dsh host process instead of
    // being reported as one offline node. So this listener stays attached for the
    // client's entire life and only records the failure; the handshake promise
    // below adds its own once-listener on top of it.
    conn.on('error', (error) => {
      this.lastError = error
      if (this.conn === conn) {
        this.conn = null
        this.ready = null
      }
    })
    conn.once('close', () => {
      if (this.conn === conn) {
        this.conn = null
        this.ready = null
      }
    })
    this.ready = new Promise((resolve, reject) => {
      const onReady = () => {
        conn.removeListener('ready', onReady)
        conn.removeListener('error', onHandshakeError)
        resolve(conn)
      }
      const onHandshakeError = (error) => {
        conn.removeListener('ready', onReady)
        conn.removeListener('error', onHandshakeError)
        // The permanent listener above already recorded the error; rejecting here
        // only settles the handshake.
        reject(error)
      }
      conn.once('ready', onReady)
      conn.once('error', onHandshakeError)
    })
    // A rejection handled later than the next tick would otherwise be reported as
    // an unhandled rejection by the host process.
    this.ready.catch(() => {})
    try {
      conn.connect(this.config)
      await this.ready
      this.lastUsed = Date.now()
      return conn
    } catch (error) {
      this.destroy()
      throw error
    }
  }

  /**
   * Run one command.
   * @param command - shell command.
   * @param timeoutMs - wall-clock ceiling for the whole channel.
   * @returns exit code, stdout, stderr, and whether the deadline hit.
   */
  async exec(command, timeoutMs) {
    const conn = await this.open()
    return await new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      const stdout = []
      const stderr = []
      const timer = setTimeout(() => {
        timedOut = true
        finish(undefined, new Error(`exec timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      const finish = (code, error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const out = Buffer.concat(stdout).toString('utf8')
        if (error !== undefined) {
          // A timed-out channel is torn down with the transport: a shell that
          // ignored the deadline would otherwise keep consuming the target.
          if (timedOut) this.destroy()
          resolve({ code: null, stdout: out, stderr: Buffer.concat(stderr).toString('utf8'), timedOut, error: error.message })
          return
        }
        this.lastUsed = Date.now()
        resolve({ code, stdout: out, stderr: Buffer.concat(stderr).toString('utf8'), timedOut, error: undefined })
      }
      conn.exec(command, (error, stream) => {
        if (error) {
          finish(undefined, error)
          return
        }
        stream.on('data', (chunk) => stdout.push(chunk))
        stream.stderr.on('data', (chunk) => stderr.push(chunk))
        stream.on('close', (code) => finish(code ?? null, undefined))
        stream.on('error', (streamError) => finish(undefined, streamError))
      })
    })
  }

  /** Tear the transport down. */
  destroy() {
    const conn = this.conn
    this.conn = null
    this.ready = null
    this.closed = true
    if (conn !== null) {
      try {
        conn.end()
      } catch {
        // Already gone.
      }
    }
  }

  /** @returns whether the connection has been idle past the close window. */
  expired() {
    return Date.now() - this.lastUsed > IDLE_CLOSE_MS
  }
}

/**
 * A per-host connection pool plus a global concurrency gate.
 *
 * Polls run in parallel up to `concurrency`, which defaults to 6: enough to
 * cover a 30-host inventory inside one 30-second interval, low enough that the
 * host's file descriptors and the targets' `sshd` MaxStartups are not stressed.
 */
export class ConnectionPool {
  /**
   * @param options - pool inputs.
   * @param options.concurrency - simultaneous polls (default 6).
   * @param options.execTimeoutMs - per-command ceiling (default 12000).
   * @param options.connectTimeoutMs - per-handshake ceiling (default 15000).
   */
  constructor(options = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 6)
    this.execTimeoutMs = Math.max(1000, options.execTimeoutMs ?? 12_000)
    this.connectTimeoutMs = Math.max(1000, options.connectTimeoutMs ?? 15_000)
    /** @type {Map<string, PooledConnection>} */
    this.connections = new Map()
    this.active = 0
    this.waiters = []
    this.idleTimer = setInterval(() => this.reap(), 60_000)
    this.idleTimer.unref?.()
  }

  /** Close connections that outlived the idle window. */
  reap() {
    for (const [alias, pooled] of [...this.connections]) {
      if (pooled.expired()) {
        pooled.destroy()
        this.connections.delete(alias)
      }
    }
  }

  /** Acquire one slot of the concurrency gate. */
  async acquire() {
    if (this.active < this.concurrency) {
      this.active += 1
      return
    }
    await new Promise(resolve => this.waiters.push(resolve))
    this.active += 1
  }

  /** Release one slot of the concurrency gate. */
  release() {
    this.active -= 1
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }

  /**
   * Poll one host: collect, parse, and report transport failures separately
   * from collector failures.
   * @param host - a discovered host entry.
   * @param config - ssh2 ConnectConfig for it.
   * @returns the parsed metrics, or an error record naming the stage.
   */
  async probe(host, config) {
    await this.acquire()
    try {
      let pooled = this.connections.get(host.alias)
      if (pooled === undefined) {
        pooled = new PooledConnection(config)
        this.connections.set(host.alias, pooled)
      }
      const started = Date.now()
      let result = await pooled.exec(PROBE_SCRIPT, this.execTimeoutMs)
      // One retry on a transport-level failure: a pooled connection that the
      // target closed while idle (sshd ClientAliveInterval, a NAT idle timer)
      // must not read as "server down".
      if (result.error !== undefined && !result.timedOut) {
        pooled.destroy()
        this.connections.delete(host.alias)
        pooled = new PooledConnection(config)
        this.connections.set(host.alias, pooled)
        result = await pooled.exec(PROBE_SCRIPT, this.execTimeoutMs)
      }
      const latencyMs = Date.now() - started
      if (result.error !== undefined) {
        pooled.destroy()
        this.connections.delete(host.alias)
        return { ok: false, stage: result.timedOut ? 'timeout' : 'transport', error: result.error, latencyMs }
      }
      const parsed = parseProbe(result.stdout)
      if (!parsed.complete) {
        return { ok: false, stage: 'collector', error: parsed.reason, latencyMs, metrics: parsed.metrics }
      }
      return { ok: true, latencyMs, metrics: parsed.metrics }
    } catch (error) {
      const existing = this.connections.get(host.alias)
      if (existing !== undefined) {
        existing.destroy()
        this.connections.delete(host.alias)
      }
      return { ok: false, stage: 'connect', error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.release()
    }
  }

  /**
   * Get the pooled connection for one host, opening it if needed.
   *
   * Callers that need several operations on the same host — the slow probe, the
   * terminal bridge, SFTP — take the connection once and reuse it. Opening a
   * fresh handshake per operation would double the target's auth log and make an
   * interactive session lag by a full key exchange on every keystroke batch.
   *
   * @param host - a discovered host entry (only `alias` is read).
   * @param config - ssh2 ConnectConfig for it.
   * @returns the open PooledConnection.
   */
  async connectionFor(host, config) {
    let pooled = this.connections.get(host.alias)
    if (pooled === undefined) {
      pooled = new PooledConnection(config)
      this.connections.set(host.alias, pooled)
    }
    await pooled.open()
    return pooled
  }

  /**
   * Run one command on a host through the pool.
   *
   * Unlike {@link probe} this does not parse anything: it is the primitive the
   * slow probe and the scheduled-task runner build on, and it keeps the same
   * single retry so an idle-closed transport is not reported as a failed command.
   *
   * @param host - a discovered host entry.
   * @param config - ssh2 ConnectConfig for it.
   * @param command - shell command.
   * @param timeoutMs - per-command ceiling; defaults to the pool's.
   * @returns `{ code, stdout, stderr, timedOut, error }`.
   */
  async run(host, config, command, timeoutMs = this.execTimeoutMs) {
    await this.acquire()
    try {
      let pooled = this.connections.get(host.alias)
      if (pooled === undefined) {
        pooled = new PooledConnection(config)
        this.connections.set(host.alias, pooled)
      }
      let result = await pooled.exec(command, timeoutMs)
      if (result.error !== undefined && !result.timedOut) {
        pooled.destroy()
        this.connections.delete(host.alias)
        pooled = new PooledConnection(config)
        this.connections.set(host.alias, pooled)
        result = await pooled.exec(command, timeoutMs)
      }
      if (result.error !== undefined) {
        pooled.destroy()
        this.connections.delete(host.alias)
      }
      return result
    } finally {
      this.release()
    }
  }

  /** Close every pooled connection. */
  dispose() {
    clearInterval(this.idleTimer)
    for (const pooled of this.connections.values()) pooled.destroy()
    this.connections.clear()
    for (const waiter of this.waiters.splice(0)) waiter()
  }
}
