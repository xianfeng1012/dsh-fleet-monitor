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
import { AlertEngine } from '../lib/alerts.js'
import { ServiceMonitor } from '../lib/services.js'
import { TaskRunner } from '../lib/tasks.js'
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

/** The hardware snapshot the detail route serves for `web-01`. */
const HARDWARE = {
  ts: 1_700_000_030_000,
  tempMax: 61.5,
  sensors: [{ name: 'coretemp', temperature: 61.5 }],
  gpu: null,
  listenPorts: 3,
  listenList: [22, 80, 443],
  partitions: [{ mount: '/', used: 5_000, total: 10_000 }],
  nics: [{ name: 'eth0', rxBytes: 1_024, txBytes: 2_048 }],
  error: null,
}

/** A store stub for the history and detail routes. */
const stubStore = {
  backend: 'sqlite',
  keep: 2880,
  history: () => [{ ts: 1_700_000_030_000, cpu_pct: 48.25, load1: 0.5, mem_used: 8_000, mem_total: 16_000, disk_used: 5_000, disk_total: 10_000, rx_bps: 1_024, tx_bps: 2_048, tcp: 12, procs: 180, temp_max: 61.5, gpu_util: null }],
  hardwareFor: (alias) => (alias === 'web-01' ? HARDWARE : null),
  // Two of the last 24 hours were collected, one fully and one half, so the
  // strip has both a solid cell and a partial one to assert on.
  hourlyCoverage: () => new Map([['web-01', [
    { hour: Math.floor(Date.now() / 3_600_000) - 1, samples: 120 },
    { hour: Math.floor(Date.now() / 3_600_000), samples: 60 },
  ]]]),
  listMeta: () => [{ alias: 'web-01', displayName: 'Web One', groupName: 'edge', tags: ['prod'], note: '', hidden: false, displayIndex: 0 }],
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

test('the fence treats localhost, 127.0.0.1 and an opaque origin as the same machine', () => {
  const page = origin => fakeRequest({ headers: { origin, 'sec-fetch-site': 'same-origin' } })
  assert.equal(
    isLoopbackRequest(page('http://localhost:22683')),
    true,
    'a websocket from the localhost page must reach the panel served on 127.0.0.1',
  )
  assert.equal(isLoopbackRequest(page('http://127.0.0.1:22683')), true, 'the same page spelled with a literal address')
  assert.equal(isLoopbackRequest(page('null')), true, 'a sandboxed or file-backed document has no usable origin')
  assert.equal(isLoopbackRequest(page('file://')), true, 'the Electron shell may serve the panel from disk')
  assert.equal(isLoopbackRequest(page('http://localhost:9999')), false, 'another local port is another application')
  assert.equal(isLoopbackRequest(page('https://evil.example')), false, 'an internet page never inherits local trust')
  assert.equal(
    isLoopbackRequest(fakeRequest({ headers: { origin: 'http://localhost:9999', 'sec-fetch-site': 'cross-site' } })),
    false,
    'the browser flag alone is still enough to refuse',
  )
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

test('overview attaches a 24 hour availability strip per host', async () => {
  const { response, body } = fakeResponse()
  await route(API.overview).handler(fakeRequest(), response)
  const payload = JSON.parse(body())

  assert.equal(payload.uptime.hours, 24)
  assert.equal(payload.uptime.measuredHosts, 1, 'only web-01 was ever collected')
  assert.equal(payload.uptime.fleet.length, 24)

  const cells = payload.nodes[0].uptime24
  assert.equal(cells.length, 24)
  // The second-to-last hour had a full 120 samples at a 30 s interval, the last
  // one only half of them, and everything before that was never collected.
  assert.equal(cells[22], 1)
  assert.equal(cells[23], 0.5)
  assert.equal(cells[0], null, 'hours with no rows are unknown, not an outage')
  assert.equal(payload.nodes[1].uptime24.every((cell) => cell === null), true)
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
  assert.equal(payload.points[0].tempMax, 61.5, 'the slow column is charted next to CPU')
})

test('the detail route joins the node, its hardware snapshot and its metadata', async () => {
  const missing = fakeResponse()
  await route(API.detail).handler(fakeRequest({ url: API.detail }), missing.response)
  assert.equal(missing.state.status, 400)

  const unknown = fakeResponse()
  await route(API.detail).handler(fakeRequest({ url: `${API.detail}?alias=nope` }), unknown.response)
  assert.equal(unknown.state.status, 404, 'a vanished node is not an empty success')

  const ok = fakeResponse()
  await route(API.detail).handler(fakeRequest({ url: `${API.detail}?alias=web-01` }), ok.response)
  assert.equal(ok.state.status, 200)
  const payload = JSON.parse(ok.body())
  assert.equal(payload.node.alias, 'web-01')
  assert.equal(payload.node.status, 'online')
  assert.equal(payload.hardware.tempMax, 61.5)
  assert.deepEqual(payload.hardware.listenList, [22, 80, 443])
  assert.equal(payload.meta.displayName, 'Web One')
  assert.equal(payload.meta.groupName, 'edge')
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
  const services = new ServiceMonitor({ store })
  const alerts = new AlertEngine({ store, config: () => ({ intervalMs: 30_000 }) })
  const pool = {
    run: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
  }
  const tasks = new TaskRunner({
    store,
    pool,
    collector: { hosts: [] },
    getConfig: () => ({ intervalMs: 30_000 }),
    emit: () => {},
  })
  const table = makeRoutes({ collector, store, getConfig: () => ({ intervalMs: 30_000 }), services, alerts, tasks })
  t.after(() => {
    tasks.dispose()
    alerts.dispose()
    services.dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, services, alerts, tasks, lookup: (path) => table.find((item) => item.path === path) }
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

// ── host metadata ───────────────────────────────────────────────────────

test('the meta route stores the panel-owned fields without renaming the alias', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  const meta = lookup(API.meta)

  const empty = fakeResponse()
  await meta.handler(fakeRequest({ url: API.meta }), empty.response)
  assert.equal(empty.state.status, 200)
  assert.deepEqual(JSON.parse(empty.body()).meta, [])

  const bad = fakeResponse()
  await meta.handler(fakeRequest({ method: 'POST', url: API.meta, body: { groupName: 'edge' } }), bad.response)
  assert.equal(bad.state.status, 400)
  assert.match(JSON.parse(bad.body()).error, /alias/)

  const saved = fakeResponse()
  await meta.handler(fakeRequest({
    method: 'POST',
    url: API.meta,
    body: {
      alias: 'web-01',
      displayName: 'Web One',
      groupName: 'edge',
      tags: ['prod', '', '   '],
      displayIndex: 2,
      note: 'primary',
    },
  }), saved.response)
  assert.equal(saved.state.status, 200)
  const row = JSON.parse(saved.body()).meta
  assert.equal(row.displayName, 'Web One')
  assert.equal(row.groupName, 'edge')
  assert.deepEqual(row.tags, ['prod'], 'blank tags are dropped, not stored as empty strings')
  assert.equal(row.displayIndex, 2)

  assert.equal(store.listMeta().length, 1, 'the row is written through to the store')

  const gone = fakeResponse()
  await meta.handler(fakeRequest({ method: 'DELETE', url: `${API.meta}?alias=nope` }), gone.response)
  assert.equal(gone.state.status, 404, 'deleting metadata nobody wrote is not a success')

  const removed = fakeResponse()
  await meta.handler(fakeRequest({ method: 'DELETE', url: `${API.meta}?alias=web-01` }), removed.response)
  assert.equal(removed.state.status, 200)
  assert.deepEqual(store.listMeta(), [])
})

test('the meta route rejects a method it does not implement', async () => {
  const wrong = fakeResponse()
  await route(API.meta).handler(fakeRequest({ method: 'PUT', url: API.meta }), wrong.response)
  assert.equal(wrong.state.status, 405)
})
test('the services route creates, lists and deletes a probe', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  const services = lookup(API.services)

  const empty = fakeResponse()
  await services.handler(fakeRequest({ method: 'GET', url: API.services }), empty.response)
  assert.equal(empty.state.status, 200)
  assert.deepEqual(JSON.parse(empty.body()).probes, [])

  const badType = fakeResponse()
  await services.handler(fakeRequest({ method: 'POST', url: API.services, body: { name: 'x', type: 9, target: 'http://a/' } }), badType.response)
  assert.equal(badType.state.status, 400)
  assert.match(JSON.parse(badType.body()).error, /type must be/)

  // An HTTP probe needs a real URL: `host:port` would throw inside fetch.
  const badUrl = fakeResponse()
  await services.handler(fakeRequest({ method: 'POST', url: API.services, body: { name: 'x', type: 1, target: 'example.com:80' } }), badUrl.response)
  assert.equal(badUrl.state.status, 400)
  assert.match(JSON.parse(badUrl.body()).error, /http/)

  // A TCP probe needs the port inside the target.
  const badTcp = fakeResponse()
  await services.handler(fakeRequest({ method: 'POST', url: API.services, body: { name: 'x', type: 2, target: 'example.com' } }), badTcp.response)
  assert.equal(badTcp.state.status, 400)
  assert.match(JSON.parse(badTcp.body()).error, /host:port/)

  const created = fakeResponse()
  await services.handler(fakeRequest({
    method: 'POST',
    url: API.services,
    body: { name: 'api', type: 1, target: 'http://127.0.0.1:1/', intervalSec: 5, timeoutMs: 100, expectStatus: '2xx' },
  }), created.response)
  assert.equal(created.state.status, 200)
  const probe = JSON.parse(created.body()).probe
  assert.equal(probe.name, 'api')
  assert.equal(probe.type, 1)
  assert.equal(probe.intervalSec, 10, 'a 5 second interval is raised to the floor')
  assert.equal(probe.timeoutMs, 500, 'a 100 ms timeout is raised to the floor')
  assert.equal(probe.expectStatus, '2xx')
  assert.equal(probe.enabled, true)
  assert.equal(store.listProbes().length, 1)

  const listed = fakeResponse()
  await services.handler(fakeRequest({ method: 'GET', url: API.services }), listed.response)
  const probes = JSON.parse(listed.body()).probes
  assert.equal(probes.length, 1)
  assert.equal(probes[0].latest, null, 'a probe that has not run yet reports no reading')
  assert.deepEqual(probes[0].grid, [])

  const wrongMethod = fakeResponse()
  await services.handler(fakeRequest({ method: 'PUT', url: API.services }), wrongMethod.response)
  assert.equal(wrongMethod.state.status, 405)

  const noId = fakeResponse()
  await services.handler(fakeRequest({ method: 'DELETE', url: API.services }), noId.response)
  assert.equal(noId.state.status, 400)

  const unknown = fakeResponse()
  await services.handler(fakeRequest({ method: 'DELETE', url: `${API.services}?id=999` }), unknown.response)
  assert.equal(unknown.state.status, 404)

  const removed = fakeResponse()
  await services.handler(fakeRequest({ method: 'DELETE', url: `${API.services}?id=${probe.id}` }), removed.response)
  assert.equal(removed.state.status, 200)
  assert.equal(store.listProbes().length, 0)
})

test('the services results route pages one probe and rejects the rest', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  const results = lookup(API.serviceResults)
  const id = store.upsertProbe({ name: 'api', type: 2, target: '127.0.0.1:1', intervalSec: 60, timeoutMs: 500 })
  for (let index = 0; index < 5; index += 1) {
    store.insertProbeResult(id, { ts: 1000 + index, ok: index < 4, latencyMs: index, statusCode: null })
  }

  const missing = fakeResponse()
  await results.handler(fakeRequest({ method: 'GET', url: API.serviceResults }), missing.response)
  assert.equal(missing.state.status, 400)

  const unknown = fakeResponse()
  await results.handler(fakeRequest({ method: 'GET', url: `${API.serviceResults}?id=999` }), unknown.response)
  assert.equal(unknown.state.status, 404)

  const ok = fakeResponse()
  await results.handler(fakeRequest({ method: 'GET', url: `${API.serviceResults}?id=${id}&limit=3` }), ok.response)
  assert.equal(ok.state.status, 200)
  const payload = JSON.parse(ok.body())
  assert.equal(payload.id, id)
  assert.equal(payload.results.length, 3)
  assert.equal(payload.results[2].ts, 1004, 'the newest cell is last')
  assert.equal(payload.results[2].ok, false)
})

test('the alerts route refuses a rule the engine could never fire', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  const alerts = lookup(API.alerts)

  const badMetric = fakeResponse()
  await alerts.handler(fakeRequest({
    method: 'POST',
    url: API.alerts,
    body: { name: 'r', metric: 'gpu_max', op: 'gt', threshold: 1 },
  }), badMetric.response)
  assert.equal(badMetric.state.status, 400)
  assert.match(JSON.parse(badMetric.body()).error, /metric must be one of/)

  // A typo used to be rounded up to "all", which silently widened a single-host
  // rule into a fleet-wide pager. It has to be a refusal.
  const badScope = fakeResponse()
  await alerts.handler(fakeRequest({
    method: 'POST',
    url: API.alerts,
    body: { name: 'r', metric: 'cpu', op: 'gt', threshold: 1, scope: { mode: 'sometimes', aliases: [] } },
  }), badScope.response)
  assert.equal(badScope.state.status, 400)
  assert.match(JSON.parse(badScope.body()).error, /scope\.mode must be one of/)

  const emptyInclude = fakeResponse()
  await alerts.handler(fakeRequest({
    method: 'POST',
    url: API.alerts,
    body: { name: 'r', metric: 'cpu', op: 'gt', threshold: 1, scope: { mode: 'include', aliases: [] } },
  }), emptyInclude.response)
  assert.equal(emptyInclude.state.status, 400)
  assert.match(JSON.parse(emptyInclude.body()).error, /at least one host/)

  const created = fakeResponse()
  await alerts.handler(fakeRequest({
    method: 'POST',
    url: API.alerts,
    body: { name: 'cpu high', metric: 'cpu', op: 'gt', threshold: 85, durationSec: 180, cooldownSec: 600, scope: { mode: 'include', aliases: ['web-01'] } },
  }), created.response)
  assert.equal(created.state.status, 200)
  const rule = JSON.parse(created.body()).rule
  assert.equal(rule.metric, 'cpu')
  assert.equal(rule.durationSec, 180)
  assert.deepEqual(rule.scope, { mode: 'include', aliases: ['web-01'] })
  assert.equal(store.listAlertRules().length, 1)

  const listed = fakeResponse()
  await alerts.handler(fakeRequest({ method: 'GET', url: API.alerts }), listed.response)
  const payload = JSON.parse(listed.body())
  assert.equal(payload.rules.length, 1)
  assert.deepEqual(payload.events, [])
  assert.equal(payload.intervalMs, 30_000)

  const unknown = fakeResponse()
  await alerts.handler(fakeRequest({ method: 'DELETE', url: `${API.alerts}?id=999` }), unknown.response)
  assert.equal(unknown.state.status, 404)

  const removed = fakeResponse()
  await alerts.handler(fakeRequest({ method: 'DELETE', url: `${API.alerts}?id=${rule.id}` }), removed.response)
  assert.equal(removed.state.status, 200)
  assert.equal(store.listAlertRules().length, 0)

  const wrongMethod = fakeResponse()
  await alerts.handler(fakeRequest({ method: 'PUT', url: API.alerts }), wrongMethod.response)
  assert.equal(wrongMethod.state.status, 405)
})

test('the notifications route ships presets as a list and keeps channels addressable', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  const notifications = lookup(API.notifications)
  const groups = lookup(API.notifyGroups)

  const empty = fakeResponse()
  await notifications.handler(fakeRequest({ method: 'GET', url: API.notifications }), empty.response)
  const initial = JSON.parse(empty.body())
  assert.deepEqual(initial.channels, [])
  assert.deepEqual(initial.groups, [])
  // The panel maps over this with `.id`, so an object here renders 0,1,2,3.
  assert.ok(Array.isArray(initial.presets))
  assert.deepEqual(initial.presets.map((item) => item.id), ['bark', 'telegram', 'lark', 'wecom'])
  assert.ok(initial.placeholders.length >= 15)
  assert.ok(initial.placeholders.every((name) => name.startsWith('#') && name.endsWith('#')))

  const badUrl = fakeResponse()
  await notifications.handler(fakeRequest({
    method: 'POST',
    url: API.notifications,
    body: { name: 'hook', url: 'ftp://example.com/x' },
  }), badUrl.response)
  assert.equal(badUrl.state.status, 400)

  const badHeaders = fakeResponse()
  await notifications.handler(fakeRequest({
    method: 'POST',
    url: API.notifications,
    body: { name: 'hook', url: 'http://127.0.0.1:1/x', headers: '{oops' },
  }), badHeaders.response)
  assert.equal(badHeaders.state.status, 400, 'a header typo is caught at save time')

  const created = fakeResponse()
  await notifications.handler(fakeRequest({
    method: 'POST',
    url: API.notifications,
    body: { name: 'hook', url: 'http://127.0.0.1:1/x', method: 'POST', body: '{"t":"#MESSAGE#"}' },
  }), created.response)
  assert.equal(created.state.status, 200)
  const channel = JSON.parse(created.body()).channel
  assert.equal(channel.enabled, true)
  assert.equal(store.listNotifyChannels().length, 1)

  const group = fakeResponse()
  await groups.handler(fakeRequest({
    method: 'POST',
    url: API.notifyGroups,
    body: { name: 'ops', channelIds: [channel.id] },
  }), group.response)
  assert.equal(group.state.status, 200)
  const listAfter = fakeResponse()
  await notifications.handler(fakeRequest({ method: 'GET', url: API.notifications }), listAfter.response)
  const after = JSON.parse(listAfter.body())
  assert.equal(after.groups.length, 1)
  assert.deepEqual(after.groups[0].channelIds, [channel.id])

  const gone = fakeResponse()
  await notifications.handler(fakeRequest({ method: 'DELETE', url: `${API.notifications}?id=${channel.id}` }), gone.response)
  assert.equal(gone.state.status, 200)
  assert.equal(store.listNotifyChannels().length, 0)

  const unknown = fakeResponse()
  await notifications.handler(fakeRequest({ method: 'DELETE', url: `${API.notifications}?id=999` }), unknown.response)
  assert.equal(unknown.state.status, 404)
})

test('the notification test route answers 502 when the endpoint is unreachable', async (t) => {
  const { lookup } = hostRouteTable(t)
  const test$ = lookup(API.notifyTest)

  const missing = fakeResponse()
  await test$.handler(fakeRequest({ method: 'POST', url: API.notifyTest, body: {} }), missing.response)
  assert.equal(missing.state.status, 400)

  // 127.0.0.1:1 refuses instantly, so this stays a fast deterministic failure
  // rather than a ten second timeout inside the suite.
  const failed = fakeResponse()
  await test$.handler(fakeRequest({
    method: 'POST',
    url: API.notifyTest,
    body: { channel: { name: 'probe', url: 'http://127.0.0.1:1/hook', method: 'POST', body: '{}' } },
  }), failed.response)
  assert.equal(failed.state.status, 502)
  assert.equal(JSON.parse(failed.body()).ok, false)
})

test('the tasks route validates the schedule before it saves anything', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  const tasks = lookup(API.tasks)

  const empty = fakeResponse()
  await tasks.handler(fakeRequest({ method: 'GET', url: API.tasks }), empty.response)
  assert.equal(empty.state.status, 200)
  assert.deepEqual(JSON.parse(empty.body()).tasks, [])

  const badSchedule = fakeResponse()
  await tasks.handler(fakeRequest({
    method: 'POST',
    url: API.tasks,
    body: { name: 'backup', schedule: '0 4 * * ', command: 'true' },
  }), badSchedule.response)
  assert.equal(badSchedule.state.status, 400)

  const impossible = fakeResponse()
  await tasks.handler(fakeRequest({
    method: 'POST',
    url: API.tasks,
    body: { name: 'backup', schedule: '0 0 30 2 *', command: 'true' },
  }), impossible.response)
  assert.equal(impossible.state.status, 400, 'a date that never arrives must not be saved')

  const noCommand = fakeResponse()
  await tasks.handler(fakeRequest({
    method: 'POST',
    url: API.tasks,
    body: { name: 'backup', schedule: '0 4 * * *' },
  }), noCommand.response)
  assert.equal(noCommand.state.status, 400)

  const emptyInclude = fakeResponse()
  await tasks.handler(fakeRequest({
    method: 'POST',
    url: API.tasks,
    body: { name: 'backup', schedule: '0 4 * * *', command: 'true', cover: { mode: 'include', aliases: [] } },
  }), emptyInclude.response)
  assert.equal(emptyInclude.state.status, 400, 'an include with no hosts would never run')

  const created = fakeResponse()
  await tasks.handler(fakeRequest({
    method: 'POST',
    url: API.tasks,
    body: { name: 'nightly', schedule: '0 4 * * *', command: 'systemctl restart app', timeoutMs: 5 },
  }), created.response)
  assert.equal(created.state.status, 200)
  const task = JSON.parse(created.body()).task
  assert.equal(task.enabled, true)
  assert.equal(task.timeoutMs, 1000, 'the timeout is clamped up to one second, not passed through')

  const list = fakeResponse()
  await tasks.handler(fakeRequest({ method: 'GET', url: API.tasks }), list.response)
  const body = JSON.parse(list.body())
  assert.equal(body.tasks.length, 1)
  assert.ok(body.tasks[0].nextRunAt > Date.now() - 1000, 'the list carries the next firing time')

  const put = fakeResponse()
  await tasks.handler(fakeRequest({ method: 'PUT', url: API.tasks }), put.response)
  assert.equal(put.state.status, 405)

  const removed = fakeResponse()
  await tasks.handler(fakeRequest({ method: 'DELETE', url: `${API.tasks}?id=${task.id}` }), removed.response)
  assert.equal(removed.state.status, 200)
  assert.equal(store.listCronTasks().length, 0)

  const again = fakeResponse()
  await tasks.handler(fakeRequest({ method: 'DELETE', url: `${API.tasks}?id=${task.id}` }), again.response)
  assert.equal(again.state.status, 404)
})

test('a task runs on demand and its output is readable from the run route', async (t) => {
  const { store, lookup } = hostRouteTable(t)
  const tasks = lookup(API.tasks)
  const runRoute = lookup(API.taskRun)
  const runsRoute = lookup(API.taskRuns)

  const created = fakeResponse()
  await tasks.handler(fakeRequest({
    method: 'POST',
    url: API.tasks,
    body: { name: 'touch', schedule: '0 4 * * *', command: 'true' },
  }), created.response)
  const task = JSON.parse(created.body()).task

  const run = fakeResponse()
  await runRoute.handler(fakeRequest({ method: 'POST', url: API.taskRun, body: { id: task.id } }), run.response)
  assert.equal(run.state.status, 200)
  // No hosts are configured in this table, so the run is trivially fine — what
  // matters is that it recorded a row the panel can then read.
  assert.equal(store.listCronRuns(task.id).length, 1)

  const runs = fakeResponse()
  await runsRoute.handler(fakeRequest({ method: 'GET', url: `${API.taskRuns}?id=${task.id}&limit=5` }), runs.response)
  assert.equal(runs.state.status, 200)
  assert.equal(JSON.parse(runs.body()).runs.length, 1)

  const missingId = fakeResponse()
  await runsRoute.handler(fakeRequest({ method: 'GET', url: API.taskRuns }), missingId.response)
  assert.equal(missingId.state.status, 400)

  const unknown = fakeResponse()
  await runsRoute.handler(fakeRequest({ method: 'GET', url: `${API.taskRuns}?id=999` }), unknown.response)
  assert.equal(unknown.state.status, 404)

  const noId = fakeResponse()
  await runRoute.handler(fakeRequest({ method: 'POST', url: API.taskRun, body: {} }), noId.response)
  assert.equal(noId.state.status, 400)

  const noTask = fakeResponse()
  await runRoute.handler(fakeRequest({ method: 'POST', url: API.taskRun, body: { id: 999 } }), noTask.response)
  assert.equal(noTask.state.status, 404)
})
