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
import { PROBE_GRID } from './store.js'
import { METRIC_NAMES } from './alerts.js'
import { PRESETS, PLACEHOLDER_NAMES, sendToChannel } from './notify.js'
import { nextRun, parseCron } from './cron.js'
import { OVERRIDABLE, pickValues, sanitiseOverrides } from './settings.js'

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
  detail: `${API_BASE}/detail`,
  meta: `${API_BASE}/meta`,
  services: `${API_BASE}/services`,
  serviceResults: `${API_BASE}/services/results`,
  alerts: `${API_BASE}/alerts`,
  alertSilence: `${API_BASE}/alerts/silence`,
  notifications: `${API_BASE}/notifications`,
  notifyGroups: `${API_BASE}/notifications/groups`,
  notifyTest: `${API_BASE}/notifications/test`,
  tasks: `${API_BASE}/tasks`,
  taskRuns: `${API_BASE}/tasks/runs`,
  taskRun: `${API_BASE}/tasks/run`,
  terminal: `${API_BASE}/terminal`,
  fsList: `${API_BASE}/fs/ls`,
  fsStat: `${API_BASE}/fs/stat`,
  fsMkdir: `${API_BASE}/fs/mkdir`,
  fsRename: `${API_BASE}/fs/rename`,
  fsDelete: `${API_BASE}/fs/delete`,
  fsDownload: `${API_BASE}/fs/download`,
  fsUpload: `${API_BASE}/fs/upload`,
  settings: `${API_BASE}/settings`,
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
/**
 * Validate one `host_meta` row submitted by the panel.
 *
 * `alias` is accepted but never renamed here: it is the join key for `node`,
 * `sample` and `host_meta`, so changing it would orphan the entire history of
 * that host. Naming is what `displayName` exists for.
 *
 * @param body - parsed JSON body.
 * @returns `{ ok: true, meta }` or `{ ok: false, error }`.
 */
function readMetaInput(body) {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'body must be an object' }
  const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
  if (alias === '') return { ok: false, error: 'alias is required' }
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const number = (value) => (Number.isFinite(value) ? Math.trunc(value) : null)
  return {
    ok: true,
    meta: {
      alias,
      displayName: text(body.displayName, 80),
      groupName: text(body.groupName, 40),
      note: text(body.note, 2000),
      hidden: body.hidden === true,
      displayIndex: Number.isFinite(body.displayIndex) ? Math.trunc(body.displayIndex) : 0,
      expireAt: number(body.expireAt),
      price: Number.isFinite(body.price) ? Number(body.price) : null,
      bandwidthGb: Number.isFinite(body.bandwidthGb) ? Number(body.bandwidthGb) : null,
      tags: Array.isArray(body.tags)
        ? body.tags
          .filter(tag => typeof tag === 'string' && tag.trim() !== '')
          .map(tag => tag.trim().slice(0, 32))
          .slice(0, 24)
        : [],
    },
  }
}

/**
 * Validate one service probe submitted by the panel.
 *
 * The target is checked per type rather than by a single loose rule: an HTTP
 * probe with a bare `host:port` would throw inside `fetch`, a TCP probe with a
 * URL would connect to nothing, and an ICMP probe with a port would silently
 * ping a name that does not exist.
 *
 * @param body - parsed JSON body.
 * @returns `{ ok: true, probe }` or `{ ok: false, error }`.
 */
function readProbeInput(body) {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'body must be an object' }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
  if (name === '') return { ok: false, error: 'name is required' }
  const type = Number(body.type)
  if (![1, 2, 3].includes(type)) return { ok: false, error: 'type must be 1 (http), 2 (tcp) or 3 (icmp)' }
  const target = typeof body.target === 'string' ? body.target.trim() : ''
  if (target === '') return { ok: false, error: 'target is required' }
  if (type === 1) {
    let url
    try {
      url = new URL(target)
    } catch {
      return { ok: false, error: 'target must be an absolute http(s) URL' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'target must use http or https' }
    }
  } else if (type === 2) {
    const cut = target.includes('://') ? -1 : target.lastIndexOf(':')
    const port = cut === -1 ? Number.NaN : Number(target.slice(cut + 1))
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ok: false, error: 'target must be host:port for a TCP probe' }
    }
  }

  const integer = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
  }
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const id = Number(body.id)
  return {
    ok: true,
    probe: {
      ...(Number.isInteger(id) && id > 0 ? { id } : {}),
      name,
      type,
      target,
      intervalSec: integer(body.intervalSec, 60, 10, 86_400),
      timeoutMs: integer(body.timeoutMs, 5000, 500, 60_000),
      expectStatus: type === 1 ? text(body.expectStatus, 64) || null : null,
      expectKeyword: type === 1 ? text(body.expectKeyword, 200) || null : null,
      maxLatencyMs: integer(body.maxLatencyMs, 0, 0, 600_000),
      notifyGroupId: Number.isInteger(Number(body.notifyGroupId)) ? Number(body.notifyGroupId) : null,
      enabled: body.enabled !== false,
    },
  }
}

/**
 * Validate one alert rule submitted by the panel.
 *
 * The metric list comes from the engine rather than from a copy here: a rule
 * that names a metric the engine cannot read would sit in the table looking
 * enabled and never fire, which is the worst possible failure for an alert.
 *
 * @param body - parsed JSON body.
 * @returns `{ ok: true, rule }` or `{ ok: false, error }`.
 */
function readRuleInput(body) {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'body must be an object' }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '') return { ok: false, error: 'name is required' }
  if (!METRIC_NAMES.includes(body.metric)) {
    return { ok: false, error: `metric must be one of: ${METRIC_NAMES.join(', ')}` }
  }
  const threshold = Number(body.threshold)
  if (!Number.isFinite(threshold)) return { ok: false, error: 'threshold must be a number' }
  const op = body.op === 'lt' ? 'lt' : 'gt'
  const durationSec = clampInteger(body.durationSec, 1, 86_400, 180)
  const cooldownSec = clampInteger(body.cooldownSec, 0, 86_400, 1800)
  // A misspelled scope is refused rather than rounded up to "all": silently
  // widening a rule to the whole fleet is how one typo pages thirty hosts.
  if (body.scope !== undefined && body.scope !== null) {
    if (typeof body.scope !== 'object') return { ok: false, error: 'scope must be an object' }
    if (body.scope.mode !== undefined && !['all', 'include', 'exclude'].includes(body.scope.mode)) {
      return { ok: false, error: 'scope.mode must be one of: all, include, exclude' }
    }
  }
  const scopeMode = body.scope?.mode ?? 'all'
  const scopeAliases = Array.isArray(body.scope?.aliases)
    ? body.scope.aliases.filter((alias) => typeof alias === 'string' && alias.trim() !== '').map((alias) => alias.trim())
    : []
  // An include list with no hosts matches nothing, so the rule would never fire.
  if (scopeMode === 'include' && scopeAliases.length === 0) {
    return { ok: false, error: 'scope.aliases must name at least one host when scope.mode is include' }
  }
  const notifyGroupId = Number.isInteger(Number(body.notifyGroupId)) && body.notifyGroupId !== null && body.notifyGroupId !== ''
    ? Number(body.notifyGroupId)
    : null
  return {
    ok: true,
    rule: {
      ...(body.id === undefined || body.id === null ? {} : { id: Number(body.id) }),
      name: name.slice(0, 120),
      metric: body.metric,
      op,
      threshold,
      durationSec,
      cooldownSec,
      scope: { mode: scopeMode, aliases: scopeAliases },
      notifyGroupId,
      enabled: body.enabled !== false,
    },
  }
}

/**
 * Validate one notification channel.
 *
 * `headers` has to parse here, unlike the sender — which tolerates bad JSON so a
 * broken channel still delivers its body — because a panel save is the one
 * moment where the operator can be told about the typo.
 *
 * @param body - parsed JSON body.
 * @returns `{ ok: true, channel }` or `{ ok: false, error }`.
 */
function readChannelInput(body) {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'body must be an object' }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '') return { ok: false, error: 'name is required' }
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (url === '') return { ok: false, error: 'url is required' }
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    return { ok: false, error: 'url must be absolute (https://… or http://…)' }
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'url must use http or https' }
  }
  const method = ['GET', 'POST', 'PUT', 'PATCH'].includes(String(body.method ?? '').toUpperCase())
    ? String(body.method).toUpperCase()
    : 'POST'
  const bodyType = body.bodyType === 'form' ? 'form' : 'json'
  let headers = '{}'
  if (body.headers !== undefined && body.headers !== null && body.headers !== '') {
    if (typeof body.headers === 'string') {
      try {
        const parsed = JSON.parse(body.headers)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, error: 'headers must be a JSON object' }
        }
        headers = JSON.stringify(parsed)
      } catch {
        return { ok: false, error: 'headers must be valid JSON' }
      }
    } else if (typeof body.headers === 'object') {
      headers = JSON.stringify(body.headers)
    }
  }
  return {
    ok: true,
    channel: {
      ...(body.id === undefined || body.id === null ? {} : { id: Number(body.id) }),
      name: name.slice(0, 120),
      url: url.slice(0, 2000),
      method,
      bodyType,
      headers,
      body: typeof body.body === 'string' ? body.body.slice(0, 4000) : '',
      verifyTls: body.verifyTls !== false,
      enabled: body.enabled !== false,
    },
  }
}

/** Clamp an integer into a range, falling back when it is not a number at all. */
function clampInteger(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** One query parameter, or null when it is absent or empty. */
function queryValue(request, name) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const value = url.searchParams.get(name)
  return value === null || value === '' ? null : value
}

/**
 * The port the host webserver is listening on, read live.
 *
 * The service answers `undefined` until it has bound, so this has to be asked
 * per request rather than captured when the routes are built.
 *
 * @returns the port as a number, or null when the service cannot say.
 */
function readServerPort(webServer) {
  if (webServer === undefined || webServer === null) return null
  const port = Number(webServer.port)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * The TCP port this request arrived on, taken from the Host header.
 *
 * Fallback for {@link readServerPort}. The Electron shell serves the panel from
 * `dsh-app://app`, where the Host header is the bare scheme authority and has no
 * port at all — which is why this is second choice, not first.
 *
 * @returns the port as a number, or null when the header does not carry one.
 */
function portOfHost(host) {
  if (typeof host !== 'string' || host === '') return null
  const match = /:(\d{1,5})$/.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * Map a filesystem failure onto a status a browser can act on.
 *
 * A refused path is the caller's mistake (400) and an unknown host is a missing
 * resource (404); everything else is the remote side failing and stays a 500
 * with the original message, because "permission denied" is the answer.
 */
function writeFsError(response, error) {
  const message = error instanceof Error ? error.message : String(error)
  if (error !== null && typeof error === 'object' && error.code === 'TOO_LARGE') {
    writeJson(response, 413, { error: message })
    return
  }
  if (message.startsWith('unknown alias')) {
    writeJson(response, 404, { error: message })
    return
  }
  if (/path is required|invalid path|path traversal|outside allowed roots|not empty|refusing to delete/.test(message)) {
    writeJson(response, 400, { error: message })
    return
  }
  writeJson(response, 500, { error: message })
}

/**
 * The next time a schedule would fire, or null when the expression is unusable.
 *
 * A row can be edited in the database by hand, so a bad expression must show up
 * as "no next run" in the table rather than as a 500 on the whole list.
 */
function safeNextRun(schedule) {
  try {
    return nextRun(parseCron(schedule))
  } catch {
    return null
  }
}

/**
 * Validate a scheduled task.
 *
 * The command is stored verbatim: it runs through a login shell on the remote
 * host, so nothing here pretends to sanitise it. What is checked is everything
 * that would fail later without an explanation — a schedule that never fires, a
 * cover that matches no host, a timeout of zero.
 *
 * @returns `{ ok: true, task }` or `{ ok: false, error }`.
 */
function readTaskInput(body) {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'body must be an object' }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '') return { ok: false, error: 'name is required' }
  if (name.length > 120) return { ok: false, error: 'name is too long (120 characters at most)' }

  const schedule = typeof body.schedule === 'string' ? body.schedule.trim() : ''
  try {
    const parsed = parseCron(schedule)
    // A syntactically valid expression can still name a date that never comes
    // (`0 0 30 2 *`). Saving it would leave a row that looks enabled and never
    // fires, which is indistinguishable from a broken scheduler.
    if (nextRun(parsed) === null) return { ok: false, error: 'schedule: this expression never fires' }
  } catch (error) {
    return { ok: false, error: `schedule: ${error instanceof Error ? error.message : 'invalid'}` }
  }

  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (command === '') return { ok: false, error: 'command is required' }
  if (command.length > 8192) return { ok: false, error: 'command is too long (8192 characters at most)' }

  let cover = { mode: 'all', aliases: [] }
  if (body.cover !== undefined && body.cover !== null) {
    if (typeof body.cover !== 'object') return { ok: false, error: 'cover must be an object' }
    const mode = body.cover.mode ?? 'all'
    if (!['all', 'include', 'exclude'].includes(mode)) {
      return { ok: false, error: 'cover.mode must be one of: all, include, exclude' }
    }
    const aliases = Array.isArray(body.cover.aliases)
      ? body.cover.aliases.filter((alias) => typeof alias === 'string' && alias.trim() !== '').map((alias) => alias.trim())
      : []
    if (mode === 'include' && aliases.length === 0) {
      return { ok: false, error: 'cover.aliases must name at least one host when cover.mode is include' }
    }
    cover = { mode, aliases }
  }

  return {
    ok: true,
    task: {
      id: body.id === undefined || body.id === null || body.id === '' ? null : Number(body.id),
      name,
      schedule,
      command,
      cover,
      timeoutMs: clampInteger(body.timeoutMs, 1000, 3_600_000, 60_000),
      notifyGroupId: body.notifyGroupId === undefined || body.notifyGroupId === null || body.notifyGroupId === ''
        ? null
        : Number(body.notifyGroupId),
      enabled: body.enabled !== false,
    },
  }
}

/**
 * Attach a 24 hour availability strip to every node.
 *
 * Each cell covers one clock hour and is the share of expected samples that
 * actually arrived. A cell is `null` when the plugin was not collecting at all
 * (before install, or after a shutdown) — that is not an outage and must not be
 * drawn as one. The current hour is included and is therefore always partial,
 * which is why the panel renders it at lower opacity instead of claiming 100%.
 */
const UPTIME_HOURS = 24
const HOUR_MS = 3_600_000

function withUptime(snapshot, store, config) {
  const intervalMs = Math.max(1, Number(config?.intervalMs) || 30_000)
  const perHour = Math.max(1, Math.round(HOUR_MS / intervalMs))
  const nowBucket = Math.floor(Date.now() / HOUR_MS)
  const coverage = store.hourlyCoverage((nowBucket - UPTIME_HOURS + 1) * HOUR_MS)

  const nodes = snapshot.nodes.map((node) => {
    const cells = new Array(UPTIME_HOURS).fill(null)
    for (const item of coverage.get(node.alias) ?? []) {
      const index = UPTIME_HOURS - 1 - (nowBucket - item.hour)
      if (index < 0 || index >= UPTIME_HOURS) continue
      cells[index] = Math.min(1, item.samples / perHour)
    }
    return { ...node, uptime24: cells }
  })

  const measured = nodes.filter((node) => node.uptime24.some((cell) => cell !== null))
  const fleetCells = new Array(UPTIME_HOURS).fill(null)
  for (let index = 0; index < UPTIME_HOURS; index += 1) {
    let sum = 0
    let count = 0
    for (const node of nodes) {
      const cell = node.uptime24[index]
      if (cell === null) continue
      sum += cell
      count += 1
    }
    fleetCells[index] = count === 0 ? null : sum / count
  }

  return {
    ...snapshot,
    nodes,
    uptime: {
      hours: UPTIME_HOURS,
      from: (nowBucket - UPTIME_HOURS + 1) * HOUR_MS,
      currentHour: nowBucket * HOUR_MS,
      measuredHosts: measured.length,
      fleet: fleetCells,
    },
  }
}

/**
 * Read the stored overrides, tolerating a store that cannot answer.
 *
 * A settings read is a convenience; it must never be the reason a route answers
 * 500, so a broken backend degrades to "nothing is overridden".
 */
function readOverrides(store) {
  try {
    return store.readSettings()
  } catch {
    return {}
  }
}

export function makeRoutes(deps) {
  const { collector, store, getConfig, services, alerts, tasks, files, webServer } = deps
  return [
    {
      kind: 'exact',
      path: API.overview,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        writeJson(response, 200, withUptime(collector.snapshot(), store, getConfig()))
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
          sweeping: snapshot.sweeping,
          backend: snapshot.backend,
          historyKeep: snapshot.historyKeep,
          intervalMs: config.intervalMs,
          slowIntervalMs: config.slowIntervalMs ?? null,
          lastRunAt: snapshot.lastRunAt,
          lastRunMs: snapshot.lastRunMs,
          lastSlowAt: snapshot.lastSlowAt,
          // Counts only: reporting the real hostnames here would let any page
          // that reaches this route enumerate the fleet.
          hostCount: snapshot.nodes.length,
          online: snapshot.nodes.filter(node => node.status === 'online').length,
          problems: snapshot.problems.length,
          // The panel may be served from a scheme that WebSocket cannot speak
          // (`dsh-app://app` in the Electron shell), where `location.origin` is
          // useless for building a ws:// URL and the Host header carries no
          // port either. The listener's own port is the only truthful answer.
          port: readServerPort(webServer) ?? portOfHost(request.headers.host),
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
            tempMax: row.temp_max ?? null,
            gpuUtil: row.gpu_util ?? null,
          })),
        })
      },
    },

    {
      kind: 'exact',
      path: API.detail,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        const url = new URL(request.url ?? '/', 'http://localhost')
        const alias = url.searchParams.get('alias')
        if (alias === null || alias === '') {
          writeJson(response, 400, { error: 'alias query parameter is required' })
          return
        }
        const node = collector.snapshot().nodes.find(entry => entry.alias === alias)
        if (node === undefined) {
          // A node that vanished (deleted from every source) is a 404, not an
          // empty 200: the panel needs to tell "gone" from "not measured yet".
          writeJson(response, 404, { error: 'unknown alias' })
          return
        }
        writeJson(response, 200, {
          alias,
          node,
          // The last hardware snapshot, complete with the error string when the
          // most recent slow sweep failed: an empty panel and a stale panel must
          // not look the same.
          hardware: store.hardwareFor(alias),
          meta: store.listMeta().find(row => row.alias === alias) ?? null,
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
        try {
          const snapshot = await collector.refresh('manual')
          writeJson(response, 200, snapshot)
        } catch (error) {
          // A rejected handler is answered by the host with a bare 400 and no
          // body, which reads exactly like a malformed request. Say what broke
          // instead, so the panel (and the operator reading it) can tell.
          writeJson(response, 500, {
            error: error instanceof Error ? error.message : 'refresh failed',
            stack: error instanceof Error ? String(error.stack ?? '').split('\n').slice(0, 6) : '',
          })
        }
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
        // A single probe has no previous sample, so CPU% cannot be derived —
        // returning 0 would read as "idle" rather than "not measured". Memory
        // and uptime are absolute, so they are reported.
        const metrics = result.metrics
        const memTotal = metrics?.mem?.totalBytes ?? 0
        const memUsed = metrics?.mem?.usedBytes ?? 0
        writeJson(response, 200, {
          ok: result.ok === true,
          stage: result.stage ?? (result.ok === true ? 'ok' : 'connect'),
          error: result.error ?? null,
          latencyMs: result.latencyMs ?? null,
          os: metrics?.os?.name ?? null,
          kernel: metrics?.os?.kernel ?? null,
          cores: metrics?.cpu?.cores ?? null,
          cpuModel: metrics?.cpu?.model ?? null,
          memPct: memTotal > 0 ? Number(((memUsed / memTotal) * 100).toFixed(1)) : null,
          uptimeSec: metrics?.uptimeSec ?? null,
        })
      },
    },

    {
      kind: 'exact',
      path: API.meta,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET', 'POST', 'DELETE'])) return

        if (request.method === 'GET') {
          writeJson(response, 200, { meta: store.listMeta() })
          return
        }

        if (request.method === 'DELETE') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const alias = url.searchParams.get('alias')
          if (alias === null || alias === '') {
            writeJson(response, 400, { error: 'alias query parameter is required' })
            return
          }
          // Deleting metadata nobody wrote is a 404: silently succeeding would
          // hide a wrong alias in the panel.
          if (!store.listMeta().some(row => row.alias === alias)) {
            writeJson(response, 404, { error: 'unknown alias' })
            return
          }
          store.deleteMeta(alias)
          writeJson(response, 200, { removed: alias })
          return
        }

        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const parsed = readMetaInput(body)
        if (!parsed.ok) {
          writeJson(response, 400, { error: parsed.error })
          return
        }
        store.upsertMeta(parsed.meta)
        writeJson(response, 200, {
          meta: store.listMeta().find(row => row.alias === parsed.meta.alias) ?? parsed.meta,
        })
      },
    },

    {
      kind: 'exact',
      path: API.services,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET', 'POST', 'DELETE'])) return

        if (request.method === 'GET') {
          writeJson(response, 200, { probes: services.list() })
          return
        }

        if (request.method === 'DELETE') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const raw = url.searchParams.get('id')
          const id = Number(raw)
          if (raw === null || raw === '' || !Number.isInteger(id)) {
            writeJson(response, 400, { error: 'id query parameter is required' })
            return
          }
          if (!store.deleteProbe(id)) {
            writeJson(response, 404, { error: 'unknown probe' })
            return
          }
          services.reload()
          writeJson(response, 200, { removed: id })
          return
        }

        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const parsed = readProbeInput(body)
        if (!parsed.ok) {
          writeJson(response, 400, { error: parsed.error })
          return
        }
        const id = store.upsertProbe(parsed.probe)
        services.reload()
        writeJson(response, 200, { probe: services.list().find(row => row.id === id) ?? { ...parsed.probe, id } })
      },
    },

    {
      kind: 'exact',
      path: API.serviceResults,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        const url = new URL(request.url ?? '/', 'http://localhost')
        const raw = url.searchParams.get('id')
        const id = Number(raw)
        if (raw === null || raw === '' || !Number.isInteger(id)) {
          writeJson(response, 400, { error: 'id query parameter is required' })
          return
        }
        if (!store.listProbes().some(probe => probe.id === id)) {
          writeJson(response, 404, { error: 'unknown probe' })
          return
        }
        const limitRaw = Number(url.searchParams.get('limit') ?? '')
        const limit = Number.isInteger(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : PROBE_GRID
        writeJson(response, 200, { id, results: store.probeResults(id, limit) })
      },
    },

    {
      kind: 'exact',
      path: API.alerts,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET', 'POST', 'DELETE'])) return

        if (request.method === 'GET') {
          writeJson(response, 200, {
            rules: store.listAlertRules(),
            events: store.listEvents(200),
            intervalMs: getConfig().intervalMs ?? 30_000,
          })
          return
        }

        if (request.method === 'DELETE') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const id = Number(url.searchParams.get('id'))
          if (!Number.isInteger(id)) {
            writeJson(response, 400, { error: 'id query parameter is required' })
            return
          }
          if (!store.deleteAlertRule(id)) {
            writeJson(response, 404, { error: 'unknown rule' })
            return
          }
          alerts.reload()
          writeJson(response, 200, { removed: id })
          return
        }

        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const parsed = readRuleInput(body)
        if (!parsed.ok) {
          writeJson(response, 400, { error: parsed.error })
          return
        }
        const id = store.upsertAlertRule(parsed.rule)
        alerts.reload()
        writeJson(response, 200, { rule: store.listAlertRules().find((row) => row.id === id) ?? { ...parsed.rule, id } })
      },
    },

    {
      kind: 'exact',
      path: API.alertSilence,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        if (body === null || typeof body !== 'object') {
          writeJson(response, 400, { error: 'body must be an object' })
          return
        }
        const ruleId = Number.isInteger(Number(body.ruleId)) && body.ruleId !== null && body.ruleId !== '' ? Number(body.ruleId) : null
        const alias = typeof body.alias === 'string' && body.alias.trim() !== '' ? body.alias.trim() : null
        const minutes = clampInteger(body.minutes, 1, 10_080, 60)
        const until = alerts.silence(ruleId, alias, minutes)
        writeJson(response, 200, { ruleId, alias, minutes, silencedUntil: until })
      },
    },

    {
      kind: 'exact',
      path: API.notifications,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET', 'POST', 'DELETE'])) return

        if (request.method === 'GET') {
          writeJson(response, 200, {
            channels: store.listNotifyChannels(),
            groups: store.listNotifyGroups(),
            presets: PRESETS,
            placeholders: PLACEHOLDER_NAMES,
          })
          return
        }

        if (request.method === 'DELETE') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const id = Number(url.searchParams.get('id'))
          if (!Number.isInteger(id)) {
            writeJson(response, 400, { error: 'id query parameter is required' })
            return
          }
          if (!store.deleteNotifyChannel(id)) {
            writeJson(response, 404, { error: 'unknown channel' })
            return
          }
          writeJson(response, 200, { removed: id })
          return
        }

        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const parsed = readChannelInput(body)
        if (!parsed.ok) {
          writeJson(response, 400, { error: parsed.error })
          return
        }
        const id = store.upsertNotifyChannel(parsed.channel)
        writeJson(response, 200, { channel: store.listNotifyChannels().find((row) => row.id === id) ?? { ...parsed.channel, id } })
      },
    },

    {
      kind: 'exact',
      path: API.notifyGroups,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET', 'POST', 'DELETE'])) return

        if (request.method === 'GET') {
          writeJson(response, 200, { groups: store.listNotifyGroups() })
          return
        }

        if (request.method === 'DELETE') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const id = Number(url.searchParams.get('id'))
          if (!Number.isInteger(id)) {
            writeJson(response, 400, { error: 'id query parameter is required' })
            return
          }
          if (!store.deleteNotifyGroup(id)) {
            writeJson(response, 404, { error: 'unknown group' })
            return
          }
          writeJson(response, 200, { removed: id })
          return
        }

        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        if (body === null || typeof body !== 'object') {
          writeJson(response, 400, { error: 'body must be an object' })
          return
        }
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          writeJson(response, 400, { error: 'name is required' })
          return
        }
        const channelIds = Array.isArray(body.channelIds)
          ? body.channelIds.map(Number).filter((id) => Number.isInteger(id))
          : []
        const id = store.upsertNotifyGroup({
          ...(body.id === undefined || body.id === null ? {} : { id: Number(body.id) }),
          name: name.slice(0, 120),
          channelIds,
        })
        writeJson(response, 200, { group: store.listNotifyGroups().find((row) => row.id === id) })
      },
    },

    {
      kind: 'exact',
      path: API.notifyTest,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const parsed = readChannelInput(body?.channel ?? body)
        if (!parsed.ok) {
          writeJson(response, 400, { error: parsed.error })
          return
        }
        // One synthetic node and rule, so a channel can be verified before any
        // real alert has ever fired. The values are deliberately obviously fake.
        const context = {
          node: { alias: 'test-host', name: '测试主机', host: '192.0.2.10', group: 'test', cpuPct: 87, mem: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2 } },
          rule: { name: '测试规则', metric: 'cpu', threshold: 85, durationSec: 180 },
          value: 87,
          state: 'firing',
          message: 'this is a test notification from dsh-fleet-monitor',
        }
        const result = await sendToChannel(parsed.channel, context)
        writeJson(response, result.ok ? 200 : 502, result)
      },
    },

    {
      kind: 'exact',
      path: API.tasks,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET', 'POST', 'DELETE'])) return
        if (request.method === 'GET') {
          writeJson(response, 200, {
            tasks: store.listCronTasks().map((task) => ({
              ...task,
              nextRunAt: safeNextRun(task.schedule),
              lastRun: store.latestCronRun(task.id),
            })),
          })
          return
        }
        if (request.method === 'DELETE') {
          const id = queryValue(request, 'id')
          if (id === null) {
            writeJson(response, 400, { error: 'id query parameter is required' })
            return
          }
          if (!store.deleteCronTask(id)) {
            writeJson(response, 404, { error: 'unknown task' })
            return
          }
          tasks.reload()
          writeJson(response, 200, { ok: true })
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const parsed = readTaskInput(body)
        if (!parsed.ok) {
          writeJson(response, 400, { error: parsed.error })
          return
        }
        const id = store.upsertCronTask(parsed.task)
        tasks.reload()
        const saved = store.listCronTasks().find((task) => task.id === id)
        writeJson(response, 200, { task: { ...saved, nextRunAt: safeNextRun(saved.schedule) } })
      },
    },

    {
      kind: 'exact',
      path: API.taskRuns,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        const id = queryValue(request, 'id')
        if (id === null) {
          writeJson(response, 400, { error: 'id query parameter is required' })
          return
        }
        if (!store.listCronTasks().some((task) => task.id === Number(id))) {
          writeJson(response, 404, { error: 'unknown task' })
          return
        }
        const limit = clampInteger(queryValue(request, 'limit'), 1, 500, 50)
        writeJson(response, 200, { id: Number(id), runs: store.listCronRuns(id, limit) })
      },
    },

    {
      kind: 'exact',
      path: API.taskRun,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        const id = Number(body?.id)
        if (!Number.isInteger(id) || id <= 0) {
          writeJson(response, 400, { error: 'id must be a task id' })
          return
        }
        const task = store.listCronTasks().find((item) => item.id === id)
        if (task === undefined) {
          writeJson(response, 404, { error: 'unknown task' })
          return
        }
        const result = await tasks.runTask(task, { manual: true })
        if (result.skipped !== undefined) {
          // 409 rather than 200: the panel has to say "busy", not "done".
          writeJson(response, 409, { error: result.skipped })
          return
        }
        writeJson(response, 200, { run: result })
      },
    },

    {
      kind: 'exact',
      path: API.fsList,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        const alias = queryValue(request, 'alias')
        if (alias === null) {
          writeJson(response, 400, { error: 'alias query parameter is required' })
          return
        }
        try {
          writeJson(response, 200, await files.list(alias, queryValue(request, 'path') ?? '/'))
        } catch (error) {
          writeFsError(response, error)
        }
      },
    },

    {
      kind: 'exact',
      path: API.fsStat,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        const alias = queryValue(request, 'alias')
        if (alias === null) {
          writeJson(response, 400, { error: 'alias query parameter is required' })
          return
        }
        try {
          writeJson(response, 200, await files.stat(alias, queryValue(request, 'path')))
        } catch (error) {
          writeFsError(response, error)
        }
      },
    },

    {
      kind: 'exact',
      path: API.fsMkdir,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        try {
          writeJson(response, 200, await files.mkdir(body?.alias, body?.path))
        } catch (error) {
          writeFsError(response, error)
        }
      },
    },

    {
      kind: 'exact',
      path: API.fsRename,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        try {
          writeJson(response, 200, await files.rename(body?.alias, body?.from, body?.to))
        } catch (error) {
          writeFsError(response, error)
        }
      },
    },

    {
      kind: 'exact',
      path: API.fsDelete,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : 'invalid body' })
          return
        }
        try {
          writeJson(response, 200, await files.remove(body?.alias, body?.path, body?.recursive === true))
        } catch (error) {
          writeFsError(response, error)
        }
      },
    },

    {
      kind: 'exact',
      path: API.fsDownload,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET'])) return
        const alias = queryValue(request, 'alias')
        if (alias === null) {
          writeJson(response, 400, { error: 'alias query parameter is required' })
          return
        }
        try {
          await files.download(alias, queryValue(request, 'path'), response)
        } catch (error) {
          // The headers may already be out, in which case only a destroyed
          // response is honest; otherwise report the reason as JSON.
          if (response.headersSent) { response.destroy(); return }
          writeFsError(response, error)
        }
      },
    },

    {
      kind: 'exact',
      path: API.fsUpload,
      handler: async (request, response) => {
        if (!guard(request, response, ['POST'])) return
        const alias = queryValue(request, 'alias')
        if (alias === null) {
          writeJson(response, 400, { error: 'alias query parameter is required' })
          return
        }
        try {
          await files.upload(alias, queryValue(request, 'path'), request, response)
        } catch (error) {
          if (response.headersSent) { response.destroy(); return }
          writeFsError(response, error)
        }
      },
    },

    {
      kind: 'exact',
      path: API.settings,
      // One handler for the whole resource, because the host's route registry
      // rejects a second registration on the same path.
      handler: async (request, response) => {
        if (!guard(request, response, ['GET', 'POST', 'DELETE'])) return
        const method = request.method ?? 'GET'

        if (method === 'GET') {
          const config = getConfig()
          writeJson(response, 200, {
            values: pickValues(config),
            // The keys the operator has actually pinned down, so the form can mark
            // them as no longer following the host config.
            overridden: Object.keys(sanitiseOverrides(readOverrides(store))),
            editable: Object.entries(OVERRIDABLE).map(([key, spec]) => ({ key, ...spec })),
          })
          return
        }

        if (method === 'DELETE') {
          store.clearSettings()
          collector.rearm()
          const config = getConfig()
          writeJson(response, 200, { values: pickValues(config), overridden: [] })
          return
        }

        const body = await readJsonBody(request)
        const raw = body !== null && typeof body === 'object' && body.values !== undefined ? body.values : body
        const next = sanitiseOverrides(raw)
        if (Object.keys(next).length === 0) {
          writeJson(response, 400, { error: 'no setting in this request is one the panel may change' })
          return
        }
        store.writeSettings(next)
        // Re-arm so a new cadence applies now rather than whenever the previous
        // setTimeout happens to fire.
        collector.rearm()
        const config = getConfig()
        writeJson(response, 200, {
          values: pickValues(config),
          overridden: Object.keys(sanitiseOverrides(readOverrides(store))),
        })
      },
    },
  ]
}
