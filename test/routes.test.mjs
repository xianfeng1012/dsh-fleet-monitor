/**
 * Route and trust-fence tests.
 *
 * These drive the handlers directly with fake request/response objects. The fence
 * is the security-relevant part of this plugin: an endpoint that reports the
 * internal topology of an operator's fleet must be unreachable from a page the
 * operator happens to have open, so every rejection path is pinned here.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { API, makeRoutes } from '../lib/routes.js'
import { openStore } from '../lib/store.js'
import {
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  isProxiedRequest,
} from '../lib/loopback.js'

/** A node as the store would join it. */
const ROW = {
  alias: 'web-01',
  host: '10.0.0.11',
  port: 22,
  user: 'deploy',
  source: 'dsh-ssh',
  status: 'online',
  last_ok: 1_700_000_030_000,
  last_error: null,
  latency_ms: 41,
  os_name: 'Ubuntu 22.04.3 LTS',
  kernel: '5.15.0-91-generic',
  arch: 'x86_64',
  cores: 8,
  cpu_model: 'Xeon',
  sample_ts: 1_700_000_030_000,
  cpu_pct: 48.25,
  load1: 0.5,
  load5: 0.4,
  load15: 0.3,
  mem_used: 8_000,
  mem_total: 16_000,
  swap_used: 0,
  swap_total: 0,
  disk_used: 5_000,
  disk_total: 10_000,
  rx_bps: 1_024,
  tx_bps: 2_048,
  rx_bytes: 1_000_000,
  tx_bytes: 2_000_000,
  tcp: 12,
  udp: 3,
  procs: 180,
  uptime_sec: 86_400,
}

/** A collector stub with one online and one offline node. */
function stubCollector() {
  const offline = { ...ROW, alias: 'db-01', host: '10.0.0.12', status: 'offline', cpu_pct: null, last_error: 'connect ETIMEDOUT', sample_ts: null }
  const snapshot = {
    running: false,
    intervalMs: 30_000,
    lastRunAt: 1_700_000_030_000,
    lastRunMs: 850,
    backend: 'sqlite',
    historyKeep: 2880,
    problems: [],
    nodes: [ROW, offline].map((row) => ({
      alias: row.alias,
      host: row.host,
      port: row.port,
      user: row.user,
      source: row.source,
      status: row.status,
      alerts: row.status === 'online' ? [] : ['offline'],
      lastOk: row.last_ok,
      lastError: row.last_error,
      latencyMs: row.latency_ms,
      os: { name: row.os_name, kernel: row.kernel, arch: row.arch },
      cores: row.cores,
      cpuModel: row.cpu_model,
      ts: row.sample_ts,
      cpuPct: row.cpu_pct,
      load: [row.load1, row.load5, row.load15],
      mem: { used: row.mem_used, total: row.mem_total, pct: (row.mem_used / row.mem_total) * 100 },
      swap: { used: row.swap_used, total: row.swap_total },
      disk: { used: row.disk_used, total: row.disk_total, pct: (row.disk_used / row.disk_total) * 100 },
      net: { rxBps: row.rx_bps, txBps: row.tx_bps, rxBytes: row.rx_bytes, txBytes: row.tx_bytes },
      conn: { tcp: row.tcp, udp: row.udp },
      procs: row.procs,
      uptimeSec: row.uptime_sec,
    })),
  }
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: async () => snapshot,
  }
}

/** A store stub for the history route. */
const stubStore = {
  backend: 'sqlite',
  keep: 2880,
  history: () => [{ ts: 1_700_000_030_000, cpu_pct: 48.25, load1: 0.5, mem_used: 8_000, mem_total: 16_000, disk_used: 5_000, disk_total: 10_000, rx_bps: 1_024, tx_bps: 2_048, tcp: 12, procs: 180 }],
}

/** Build the route table once. */
const routes = makeRoutes({ collector: stubCollector(), store: stubStore, getConfig: () => ({ intervalMs: 30_000 }) })

/** Find one route by path. */
const route = (path) => {
  const found = routes.find((item) => item.path === path)
  assert.ok(found !== undefined, `route ${path} is registered`)
  return found
}

/** A fake request. */
function fakeRequest({ method = 'GET', url = '/', host = '127.0.0.1:22683', remoteAddress = '127.0.0.1', headers = {}, body } = {}) {
  return {
    method,
    url,
    socket: { remoteAddress },
    headers: { host, ...headers },
    on() {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
}

/** A fake response that records what the handler wrote. */
function fakeResponse() {
  const state = { status: 0, headers: {}, chunks: [], ended: false }
  const response = {
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
    },
    write(chunk) {
      state.chunks.push(chunk)
      return true
    },
    end(chunk) {
      if (chunk !== undefined) state.chunks.push(chunk)
      state.ended = true
    },
    on() {},
  }
  return { response, state, body: () => state.chunks.join('') }
}

test('the address predicates cover the loopback range only', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.9.9.9'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.11'), false)
  assert.equal(isLoopbackAddress('192.168.1.1'), false)
  assert.equal(isLoopbackAddress(undefined), false)
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('example.com'), false)
})

test('a forwarding header always means a hop stood in between', () => {
  assert.equal(isProxiedRequest({ headers: {} }), false)
  assert.equal(isProxiedRequest({ headers: { 'x-forwarded-for': '127.0.0.1' } }), true)
  assert.equal(isProxiedRequest({ headers: { 'cf-connecting-ip': '1.2.3.4' } }), true)
})

test('isLoopbackRequest accepts a same-origin local page and rejects the rest', () => {
  assert.equal(isLoopbackRequest(fakeRequest()), true, 'plain local GET')
  assert.equal(
    isLoopbackRequest(fakeRequest({ headers: { origin: 'http://127.0.0.1:22683', 'sec-fetch-site': 'same-origin' } })),
    true,
    'same-origin fetch',
  )
  assert.equal(isLoopbackRequest(fakeRequest({ remoteAddress: '10.0.0.11' })), false, 'off-box socket')
  assert.equal(
    isLoopbackRequest(fakeRequest({ headers: { 'x-forwarded-for': '10.0.0.11' } })),
    false,
    'proxied request is not local just because the proxy dialled loopback',
  )
  assert.equal(
    isLoopbackRequest(fakeRequest({ headers: { origin: 'https://evil.example' } })),
    false,
    'cross-origin page',
  )
  assert.equal(
    isLoopbackRequest(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } })),
    false,
    'browser marks the cross-site fetch even without Origin',
  )
  assert.equal(isLoopbackRequest(fakeRequest({ host: 'example.com' })), false, 'non-local Host header')
})

test('every route refuses a non-loopback caller', async () => {
  for (const item of routes) {
    const { response, state } = fakeResponse()
    await item.handler(fakeRequest({ method: item.path === API.refresh ? 'POST' : 'GET', remoteAddress: '203.0.113.5' }), response)
    assert.equal(state.status, 403, `${item.path} is fenced`)
    assert.match(JSON.parse(state.chunks.join('')).error, /loopback-only/)
  }
})

test('overview serves the shaped snapshot', async () => {
  const { response, state, body } = fakeResponse()
  await route(API.overview).handler(fakeRequest(), response)
  assert.equal(state.status, 200)
  assert.equal(state.headers['cache-control'], 'no-store')
  const payload = JSON.parse(body())
  assert.equal(payload.nodes.length, 2)
  assert.equal(payload.nodes[0].cpuPct, 48.25)
  assert.deepEqual(payload.nodes[1].alerts, ['offline'])
})

test('status reports counts without naming any host', async () => {
  const { response, state, body } = fakeResponse()
  await route(API.status).handler(fakeRequest(), response)
  const payload = JSON.parse(body())
  assert.equal(state.status, 200)
  assert.equal(payload.hostCount, 2)
  assert.equal(payload.online, 1)
  assert.equal(body().includes('web-01'), false, 'the status route must not leak aliases')
  assert.equal(body().includes('10.0.0.11'), false)
})

test('history requires an alias and clamps the limit', async () => {
  const missing = fakeResponse()
  await route(API.history).handler(fakeRequest({ url: API.history }), missing.response)
  assert.equal(missing.state.status, 400)
  assert.match(JSON.parse(missing.body()).error, /alias/)

  const ok = fakeResponse()
  await route(API.history).handler(fakeRequest({ url: `${API.history}?alias=web-01&from=1700000000000&limit=999999` }), ok.response)
  assert.equal(ok.state.status, 200)
  const payload = JSON.parse(ok.body())
  assert.equal(payload.alias, 'web-01')
  assert.equal(payload.points.length, 1)
  assert.equal(payload.points[0].cpuPct, 48.25)
})

test('refresh is POST-only', async () => {
  const wrong = fakeResponse()
  await route(API.refresh).handler(fakeRequest({ method: 'GET', url: API.refresh }), wrong.response)
  assert.equal(wrong.state.status, 405)

  const ok = fakeResponse()
  await route(API.refresh).handler(fakeRequest({ method: 'POST', url: API.refresh }), ok.response)
  assert.equal(ok.state.status, 200)
})

test('events opens an SSE stream with the right headers and an initial frame', async () => {
  const { response, state, body } = fakeResponse()
  await route(API.events).handler(fakeRequest({ url: API.events }), response)
  assert.equal(state.status, 200)
  assert.match(state.headers['content-type'], /text\/event-stream/)
  assert.equal(state.headers['cache-control'], 'no-store')
  assert.equal(state.headers['x-accel-buffering'], 'no')
  assert.match(body(), /^data: \{/, 'the current snapshot is the first frame')
  assert.equal(state.ended, false, 'the stream stays open')
})

// ── panel-owned hosts ───────────────────────────────────────────────────

/**
 * Build a route table backed by a real store, so the CRUD path runs against the
 * schema the host actually ships instead of a hand-shaped stub.
 * @param t - the test context, for cleanup.
 * @returns the store plus a path lookup.
 */
function hostRouteTable(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fm-routes-'))
  const store = openStore({ dshHome: dir, keep: 50 })
  const collector = {
    ...stubCollector(),
    listImported: () => [{ alias: 'web-01', host: '10.0.0.11', port: 22, user: 'deploy', source: 'dsh-ssh', tags: [], description: null }],
    dropHost: () => {},
    probeOne: async () => ({
      ok: true,
      stage: 'ok',
      latencyMs: 12,
      metrics: { os: { name: 'Ubuntu 22.04' }, cpuPct: 3, memPct: 40 },
    }),
  }
  const table = makeRoutes({ collector, store, getConfig: () => ({ intervalMs: 30_000 }) })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, lookup: (path) => table.find((item) => item.path === path) }
}

test('the hosts route adds, lists and deletes a panel-owned host', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  const hosts = lookup(API.hosts)

  const empty = fakeResponse()
  await hosts.handler(fakeRequest({ url: API.hosts }), empty.response)
  assert.equal(empty.state.status, 200)
  assert.deepEqual(JSON.parse(empty.body()).hosts, [])
  assert.equal(JSON.parse(empty.body()).imported.length, 1, 'imported hosts are reported separately')

  const created = fakeResponse()
  await hosts.handler(fakeRequest({
    method: 'POST',
    url: API.hosts,
    body: { alias: 'edge-1', host: '10.9.9.9', port: 2222, user: 'ops', authKind: 'agent', tags: ['edge'] },
  }), created.response)
  assert.equal(created.state.status, 200)
  const saved = JSON.parse(created.body()).host
  assert.equal(saved.alias, 'edge-1')
  assert.equal(saved.port, 2222)
  assert.deepEqual(store.listManaged().map((row) => row.alias), ['edge-1'])

  const listed = fakeResponse()
  await hosts.handler(fakeRequest({ url: API.hosts }), listed.response)
  assert.deepEqual(JSON.parse(listed.body()).hosts.map((row) => row.alias), ['edge-1'])

  const removed = fakeResponse()
  await hosts.handler(fakeRequest({ method: 'DELETE', url: `${API.hosts}?alias=edge-1` }), removed.response)
  assert.equal(removed.state.status, 200)
  assert.deepEqual(store.listManaged(), [])

  const again = fakeResponse()
  await hosts.handler(fakeRequest({ method: 'DELETE', url: `${API.hosts}?alias=edge-1` }), again.response)
  assert.equal(again.state.status, 404, 'deleting twice is not a success')
})

test('the host list never returns a stored secret', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  store.upsertManaged({
    alias: 'pw-1', host: '10.1.1.1', port: 22, user: 'root',
    authKind: 'password', password: 'hunter2', keyPath: null, passphrase: null,
    tags: [], note: null, groupName: null,
  })
  const response = fakeResponse()
  await lookup(API.hosts).handler(fakeRequest({ url: API.hosts }), response.response)
  const text = response.body()
  assert.equal(text.includes('hunter2'), false, 'the password never crosses the wire')
  assert.equal(JSON.parse(text).hosts[0].hasPassword, true, 'its presence is still reported')
})

test('the test route validates the host before dialling anything', async (t) => {
  const { lookup } = hostRouteTable(t)
  const testRoute = lookup(API.test)

  const missing = fakeResponse()
  await testRoute.handler(fakeRequest({ method: 'POST', url: API.test, body: { port: 22 } }), missing.response)
  assert.equal(missing.state.status, 400)

  const badPort = fakeResponse()
  await testRoute.handler(fakeRequest({ method: 'POST', url: API.test, body: { host: '10.0.0.1', port: 0 } }), badPort.response)
  assert.equal(badPort.state.status, 400)

  const noKey = fakeResponse()
  await testRoute.handler(fakeRequest({
    method: 'POST', url: API.test, body: { host: '10.0.0.1', authKind: 'key' },
  }), noKey.response)
  assert.equal(noKey.state.status, 400)

  const ok = fakeResponse()
  await testRoute.handler(fakeRequest({
    method: 'POST', url: API.test, body: { host: '10.0.0.1', authKind: 'agent' },
  }), ok.response)
  assert.equal(ok.state.status, 200)
  assert.equal(JSON.parse(ok.body()).ok, true)
})