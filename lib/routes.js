/**
 * The `/api/dsh-fleet-monitor` route family.
 *
 * Live updates ride **Server-Sent Events**, not a WebSocket: an SSE response is
 * an ordinary HTTP response, so it needs no protocol library, no `ws`
 * dependency, and no upgrade plumbing in the host's webserver. The browser half
 * uses the built-in `EventSource`. Every route sits behind the loopback fence.
 *
 * @module dsh-fleet-monitor/routes
 */

import { guard, readJsonBody, writeJson } from './http.js'

/** Route path prefix, shared with the browser half. */
export const API_BASE = '/api/dsh-fleet-monitor'

/** Every path this plugin serves. */
export const API = {
  overview: `${API_BASE}/overview`,
  events: `${API_BASE}/events`,
  history: `${API_BASE}/history`,
  refresh: `${API_BASE}/refresh`,
  status: `${API_BASE}/status`,
  hosts: `${API_BASE}/hosts`,
  test: `${API_BASE}/test`,
}

/** Auth kinds the panel can write; anything else falls back to the agent. */
const AUTH_KINDS = new Set(['key', 'password', 'agent'])

/**
 * Validate one host submitted by the panel.
 *
 * Every field is re-derived here rather than trusted: the caller is a page that
 * shares the loopback fence with this route, and a bad `port` would otherwise
 * reach `ssh2` as a string and open a connection to a port nobody chose.
 *
 * @param body - parsed JSON body.
 * @returns `{ ok: true, host }` or `{ ok: false, error }`.
 */
function readHostInput(body) {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'body must be an object' }
  const hostname = typeof body.host === 'string' ? body.host.trim() : ''
  if (hostname === '') return { ok: false, error: 'host is required' }
  const portRaw = body.port === undefined || body.port === null || body.port === '' ? 22 : Number(body.port)
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65_535) {
    return { ok: false, error: 'port must be an integer between 1 and 65535' }
  }
  const user = typeof body.user === 'string' && body.user.trim() !== '' ? body.user.trim() : 'root'
  const authKind = AUTH_KINDS.has(body.authKind) ? body.authKind : 'key'
  const keyPath = typeof body.keyPath === 'string' ? body.keyPath.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (authKind === 'key' && keyPath === '') return { ok: false, error: 'keyPath is required for key auth' }
  if (authKind === 'password' && password === '') return { ok: false, error: 'password is required for password auth' }
  const alias = typeof body.alias === 'string' && body.alias.trim() !== ''
    ? body.alias.trim()
    : `${user}@${hostname}:${portRaw}`
  const tags = Array.isArray(body.tags)
    ? body.tags.filter(tag => typeof tag === 'string' && tag.trim() !== '').map(tag => tag.trim())
    : []
  return {
    ok: true,
    host: {
      alias,
      host: hostname,
      port: portRaw,
      user,
      authKind,
      keyPath: authKind === 'key' ? keyPath : null,
      passphrase: typeof body.passphrase === 'string' && body.passphrase !== '' ? body.passphrase : null,
      password: authKind === 'password' ? password : null,
      tags,
      note: typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null,
      groupName: typeof body.groupName === 'string' && body.groupName.trim() !== '' ? body.groupName.trim() : null,
    },
  }
}

/**
 * Strip credentials before a host record leaves the host process.
 *
 * The panel never needs the stored secret back — it only needs to know that one
 * exists — so a saved password is reported as `hasPassword` instead of itself.
 * @param row - a `managed_host` record in camelCase.
 * @returns the record with secrets replaced by presence flags.
 */
function publicHost(row) {
  return {
    alias: row.alias,
    host: row.host,
    port: row.port,
    user: row.user,
    authKind: row.authKind,
    keyPath: row.keyPath,
    hasPassword: typeof row.password === 'string' && row.password !== '',
    hasPassphrase: typeof row.passphrase === 'string' && row.passphrase !== '',
    tags: row.tags,
    note: row.note,
    groupName: row.groupName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Keepalive comment interval for the SSE stream (proxies drop idle 200s). */
const SSE_PING_MS = 25_000

/**
 * Build the route list.
 * @param deps - route dependencies.
 * @param deps.collector - the collector owning the loop.
 * @param deps.store - the history store, for the history route.
 * @param deps.getConfig - live config reader.
 * @returns exact-path WebRoute objects for `ctx.webServer.register`.
 */
export function makeRoutes(deps) {
  const { collector, store, getConfig } = deps

  return [
    {
      kind: 'exact',
      path: API.overview,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        writeJson(response, 200, collector.snapshot())
      },
    },

    {
      kind: 'exact',
      path: API.status,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        const config = getConfig()
        const snapshot = collector.snapshot()
        writeJson(response, 200, {
          running: snapshot.running,
          backend: snapshot.backend,
          historyKeep: snapshot.historyKeep,
          intervalMs: config.intervalMs,
          lastRunAt: snapshot.lastRunAt,
          lastRunMs: snapshot.lastRunMs,
          // Counts only: reporting the real hostnames here would let any page
          // that reaches this route enumerate the fleet.
          hostCount: snapshot.nodes.length,
          online: snapshot.nodes.filter(node => node.status === 'online').length,
          problems: snapshot.problems.length,
        })
      },
    },

    {
      kind: 'exact',
      path: API.events,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          // Defensive against an upstream proxy that would otherwise buffer the
          // stream into one giant response.
          'x-accel-buffering': 'no',
        })
        const send = (payload) => {
          try {
            response.write(`data: ${JSON.stringify(payload)}\n\n`)
          } catch {
            // The client vanished between the event and the write.
          }
        }
        send(collector.snapshot())
        const unsubscribe = collector.subscribe(send)
        const ping = setInterval(() => {
          try {
            response.write(': ping\n\n')
          } catch {
            // Closed.
          }
        }, SSE_PING_MS)
        ping.unref?.()
        const close = () => {
          clearInterval(ping)
          unsubscribe()
        }
        request.on('close', close)
        response.on('close', close)
        response.on('error', close)
      },
    },

    {
      kind: 'exact',
      path: API.history,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        const url = new URL(request.url ?? '/', 'http://localhost')
        const alias = url.searchParams.get('alias')
        if (alias === null || alias === '') {
          writeJson(response, 400, { error: 'alias query parameter is required' })
          return
        }
        const fromRaw = Number(url.searchParams.get('from') ?? '0')
        const limitRaw = Number(url.searchParams.get('limit') ?? '240')
        const from = Number.isFinite(fromRaw) && fromRaw > 0 ? fromRaw : 0
        const limit = Number.isFinite(limitRaw) ? Math.min(2000, Math.max(1, Math.trunc(limitRaw))) : 240
        const rows = store.history(alias, from, limit)
        writeJson(response, 200, {
          alias,
          backend: store.backend,
          keep: store.keep,
          points: rows.map(row => ({
            ts: row.ts,
            cpuPct: row.cpu_pct ?? null,
            load1: row.load1 ?? null,
            memUsed: row.mem_used ?? null,
            memTotal: row.mem_total ?? null,
            diskUsed: row.disk_used ?? null,
            diskTotal: row.disk_total ?? null,
            rxBps: row.rx_bps ?? null,
            txBps: row.tx_bps ?? null,
            tcp: row.tcp ?? null,
            procs: row.procs ?? null,
          })),
        })
      },
    },

    {
      kind: 'exact',
      path: API.refresh,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        // The body is optional: a bare POST is the panel's "refresh now".
        await readJsonBody(request)
        const snapshot = await collector.refresh('manual')
        writeJson(response, 200, snapshot)
      },
    },

    {
      kind: 'exact',
      path: API.hosts,
      handler: async (request, response) => {
        const method = request.method ?? 'GET'
        if (!guard(request, response, ['GET', 'POST', 'DELETE'])) return

        if (method === 'GET') {
          writeJson(response, 200, {
            hosts: store.listManaged().map(publicHost),
            // Imported hosts are reported read-only, so the panel can show them
            // without offering an edit control that would be silently ignored.
            imported: collector.listImported(),
          })
          return
        }

        if (method === 'POST') {
          let body
          try {
            body = await readJsonBody(request)
          } catch (error) {
            writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
            return
          }
          const parsed = readHostInput(body)
          if (!parsed.ok) {
            writeJson(response, 400, { error: parsed.error })
            return
          }
          store.upsertManaged(parsed.host)
          // Fire and forget: the operator gets their saved row back at once, and
          // the first sample lands on the next tick (or the manual refresh).
          void collector.refresh('host-added').catch(() => {})
          writeJson(response, 200, { host: publicHost({ ...parsed.host, createdAt: Date.now(), updatedAt: Date.now() }) })
          return
        }

        // DELETE ?alias=... — the alias is a JSON-safe identifier, never a path.
        const url = new URL(request.url ?? '/', 'http://localhost')
        const alias = url.searchParams.get('alias')
        if (alias === null || alias === '') {
          writeJson(response, 400, { error: 'alias query parameter is required' })
          return
        }
        const existing = store.listManaged().find(row => row.alias === alias)
        if (existing === undefined) {
          writeJson(response, 404, { error: 'no panel-managed host with that alias' })
          return
        }
        store.deleteManaged(alias)
        store.forget(alias)
        collector.dropHost(alias)
        void collector.refresh('host-removed').catch(() => {})
        writeJson(response, 200, { removed: alias })
      },
    },

    {
      kind: 'exact',
      path: API.test,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const parsed = readHostInput(body)
        if (!parsed.ok) {
          writeJson(response, 400, { error: parsed.error })
          return
        }
        const auth = {
          kind: parsed.host.authKind,
          keyPath: parsed.host.keyPath ?? undefined,
          passphrase: parsed.host.passphrase ?? undefined,
          password: parsed.host.password ?? undefined,
        }
        const result = await collector.probeOne({ ...parsed.host, auth })
        writeJson(response, 200, {
          ok: result.ok === true,
          stage: result.stage,
          error: result.error ?? null,
          latencyMs: result.latencyMs ?? null,
          os: result.metrics?.os ?? null,
          cpuPct: result.metrics?.cpuPct ?? null,
          memPct: result.metrics?.memPct ?? null,
        })
      },
    },
  ]
}
