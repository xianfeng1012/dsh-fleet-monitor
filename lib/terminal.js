/**
 * An SSH shell bridged to a WebSocket, one session per connection.
 *
 * The frame vocabulary matches dsh-ssh's terminal protocol so the two panels
 * feel the same, but the sessions are separate: this plugin never reuses another
 * plugin's shell, and dropping this panel does not disturb one that is open
 * there.
 *
 * What this is not: a VT100 emulator. Escape sequences are forwarded verbatim to
 * the browser and rendered by the panel's own lightweight screen, so full-screen
 * programs (vim, htop, top without `-b`) draw nothing useful. The panel says so
 * rather than pretending, and dsh-ssh's terminal remains the place for those.
 */

import { randomUUID } from 'node:crypto'

import { resolveAuth } from './hosts.js'

/** A detached session keeps its shell alive this long, then is reaped. */
const DETACH_TTL_MS = 5 * 60 * 1000
/** Output frames are batched: one small frame per keystroke echo is wasteful. */
const FLUSH_MS = 16
/** A session that produces this much output without being read is dropped. */
const MAX_BUFFERED_CHARS = 512 * 1024

/**
 * One live shell.
 *
 * `send` writes a server frame, `handle` consumes a client frame. The transport
 * is deliberately not known here, which keeps the registry testable without a
 * socket.
 */
class ShellSession {
  constructor({ id, alias, stream, send, onClosed }) {
    this.id = id
    this.alias = alias
    this.stream = stream
    this.send = send
    this.onClosed = onClosed
    this.pending = ''
    this.flushTimer = null
    this.closed = false
    this.detachedUntil = 0

    stream.on('data', (chunk) => this.push(chunk.toString('utf8')))
    stream.stderr?.on('data', (chunk) => this.push(chunk.toString('utf8')))
    stream.on('close', (code) => this.exit(code))
    stream.on('error', (error) => this.fail(error instanceof Error ? error.message : String(error)))
  }

  push(text) {
    if (this.closed) return
    this.pending += text
    if (this.pending.length > MAX_BUFFERED_CHARS) {
      // Nobody is reading: keep the tail (where the error is) and drop the rest
      // rather than growing the host's heap for a view that is not there.
      this.pending = `[output truncated]\n${this.pending.slice(-64 * 1024)}`
    }
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_MS)
    this.flushTimer.unref?.()
  }

  flush() {
    if (this.closed || this.pending === '') return
    const data = this.pending
    this.pending = ''
    this.send({ type: 'output', data })
  }

  handle(frame) {
    if (this.closed) return
    if (frame.type === 'input' && typeof frame.data === 'string') {
      this.stream.write(frame.data)
      return
    }
    if (frame.type === 'resize') {
      const cols = Number(frame.cols)
      const rows = Number(frame.rows)
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        try { this.stream.setWindow(rows, cols, 0, 0) } catch {}
      }
      return
    }
    if (frame.type === 'detach') {
      this.detachedUntil = Date.now() + DETACH_TTL_MS
      this.flush()
      return
    }
    if (frame.type === 'close') {
      this.close(1000, 'client closed the session')
    }
  }

  /** Reap a detached session whose keep-alive window elapsed. */
  expired(now) {
    return this.detachedUntil > 0 && now > this.detachedUntil
  }

  exit(code) {
    if (this.closed) return
    this.flush()
    this.send({ type: 'exit', code: code === undefined ? null : code })
    this.close(1000, 'shell exited')
  }

  fail(error) {
    if (this.closed) return
    this.send({ type: 'exit', code: null, error })
    this.close(1011, error)
  }

  close(code, reason) {
    if (this.closed) return
    this.closed = true
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try { this.stream.end() } catch {}
    this.onClosed(this.id, code, reason)
  }
}

export class TerminalRegistry {
  /**
   * @param {object} deps
   * @param {object} deps.pool - SSH pool with `connectionFor(host, config)`
   * @param {object} deps.collector - source of the current host list
   * @param {() => object} deps.getConfig - live plugin config
   */
  constructor({ pool, collector, getConfig }) {
    this.pool = pool
    this.collector = collector
    this.getConfig = getConfig
    this.sessions = new Map()
    this.reaper = null
  }

  start() {
    if (this.reaper !== null) return
    this.reaper = setInterval(() => {
      const now = Date.now()
      for (const session of [...this.sessions.values()]) {
        if (session.expired(now)) session.close(1000, 'detached session expired')
      }
    }, 30_000)
    this.reaper.unref?.()
  }

  dispose() {
    if (this.reaper !== null) {
      clearInterval(this.reaper)
      this.reaper = null
    }
    for (const session of [...this.sessions.values()]) session.close(1001, 'plugin unloaded')
    this.sessions.clear()
  }

  /** @returns the host record, or undefined when the alias is not configured. */
  hostFor(alias) {
    return this.collector.hosts.find((host) => host.alias === alias)
  }

  /**
   * Open a shell for `alias` and hand its frames to `send`.
   *
   * @param {string} alias
   * @param {{cols: number, rows: number}} size
   * @param {(frame: object) => void} send
   * @param {() => void} [onGone] - called when the session ends, so the caller can close the socket
   */
  async open(alias, size, send, onGone) {
    const host = this.hostFor(alias)
    if (host === undefined) {
      send({ type: 'exit', code: null, error: `unknown host: ${alias}` })
      onGone?.()
      return null
    }
    if (host.proxyJump !== undefined && host.proxyJump.length > 0) {
      send({ type: 'exit', code: null, error: 'proxy jump is not supported yet' })
      onGone?.()
      return null
    }

    const config = this.getConfig()
    let stream
    try {
      const auth = resolveAuth(host, {
        connectTimeoutMs: config.connectTimeoutMs,
        agentSocket: config.agentSocket === '' ? undefined : config.agentSocket,
      })
      const pooled = await this.pool.connectionFor(host, auth)
      const conn = pooled.conn
      if (conn === undefined || conn === null) throw new Error('the pooled connection is not open')
      stream = await new Promise((resolve, reject) => {
        conn.shell({
          term: 'xterm-256color',
          cols: size.cols,
          rows: size.rows,
        }, (error, channel) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(channel)
        })
      })
    } catch (error) {
      send({ type: 'exit', code: null, error: error instanceof Error ? error.message : String(error) })
      onGone?.()
      return null
    }

    const id = randomUUID()
    const session = new ShellSession({
      id,
      alias,
      stream,
      send,
      onClosed: (closedId, code, reason) => {
        this.sessions.delete(closedId)
        send({ type: 'exit', code: null })
        onGone?.(code, reason)
      },
    })
    this.sessions.set(id, session)
    send({ type: 'ready', alias, sessionId: id })
    return session
  }

  /** Reattach an existing session to a new transport. @returns the session, or null. */
  reattach(sessionId, send, onGone) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return null
    session.send = send
    session.detachedUntil = 0
    session.onClosed = (closedId, code, reason) => {
      this.sessions.delete(closedId)
      send({ type: 'exit', code: null })
      onGone?.(code, reason)
    }
    send({ type: 'ready', alias: session.alias, sessionId })
    return session
  }
}
