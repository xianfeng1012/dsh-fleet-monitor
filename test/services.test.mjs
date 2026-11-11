import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROBE_HTTP,
  PROBE_ICMP,
  PROBE_TCP,
  ServiceMonitor,
  certDaysLeft,
  matchStatus,
  runProbeOnce,
} from '../lib/services.js'
import { PROBE_GRID, PROBE_KEEP, openStore } from '../lib/store.js'

/** Start an HTTP server on a random port, run `body`, then close it. */
async function withHttpServer(handler, body) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await body(port)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

/** Reserve a port, then release it, so the TCP probe hits a closed one. */
async function closedPort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test('matchStatus accepts exact, class, list and regex expectations', () => {
  assert.equal(matchStatus(200, '200'), true)
  assert.equal(matchStatus(204, '200'), false)
  assert.equal(matchStatus(204, '2xx'), true)
  assert.equal(matchStatus(302, '2xx'), false)
  assert.equal(matchStatus(204, '200,204'), true)
  assert.equal(matchStatus(500, '200,204'), false)
  assert.equal(matchStatus(201, '/^2\\d\\d$/'), true)
  assert.equal(matchStatus(500, '/^2\\d\\d$/'), false)
  // A malformed regex is the operator's typo, not a reason to throw.
  assert.equal(matchStatus(200, '/[/'), false)
})

test('matchStatus treats an empty expectation as "under 400"', () => {
  assert.equal(matchStatus(200, ''), true)
  assert.equal(matchStatus(302, ''), true)
  assert.equal(matchStatus(404, ''), false)
  assert.equal(matchStatus(500, undefined), false)
})

test('certDaysLeft returns null when nothing answers on 443', async () => {
  // TEST-NET-1 is never routed, so this exercises the timeout path.
  const days = await certDaysLeft('192.0.2.1', 300)
  assert.equal(days, null)
})

test('the http probe records the status code and the keyword verdict', async () => {
  await withHttpServer(
    (request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<title>service is healthy</title>')
    },
    async (port) => {
      const ok = await runProbeOnce({
        type: PROBE_HTTP,
        target: `http://127.0.0.1:${port}/`,
        timeoutMs: 3000,
        expectStatus: '2xx',
        expectKeyword: 'healthy',
      })
      assert.equal(ok.ok, true)
      assert.equal(ok.statusCode, 200)
      assert.equal(ok.error, null)
      assert.equal(typeof ok.latencyMs, 'number')

      const missing = await runProbeOnce({
        type: PROBE_HTTP,
        target: `http://127.0.0.1:${port}/`,
        timeoutMs: 3000,
        expectStatus: '2xx',
        expectKeyword: 'database up',
      })
      assert.equal(missing.ok, false)
      assert.equal(missing.statusCode, 200)
      assert.match(missing.error, /body did not contain/)
    },
  )
})

test('the http probe reports a status mismatch with the expectation in the message', async () => {
  await withHttpServer(
    (request, response) => {
      response.writeHead(500)
      response.end('boom')
    },
    async (port) => {
      const result = await runProbeOnce({
        type: PROBE_HTTP,
        target: `http://127.0.0.1:${port}/`,
        timeoutMs: 3000,
        expectStatus: '200',
      })
      assert.equal(result.ok, false)
      assert.equal(result.statusCode, 500)
      assert.match(result.error, /status 500 did not match 200/)
    },
  )
})

test('the http probe turns a refused connection into a readable error', async () => {
  const port = await closedPort()
  const result = await runProbeOnce({
    type: PROBE_HTTP,
    target: `http://127.0.0.1:${port}/`,
    timeoutMs: 2000,
    expectStatus: '',
  })
  assert.equal(result.ok, false)
  assert.equal(result.statusCode, null)
  assert.equal(typeof result.error, 'string')
})

test('the tcp probe succeeds on a listening port and fails on a closed one', async () => {
  const server = net.createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const open = await runProbeOnce({ type: PROBE_TCP, target: `127.0.0.1:${port}`, timeoutMs: 2000 })
    assert.equal(open.ok, true)
    assert.equal(open.error, null)
    assert.equal(typeof open.latencyMs, 'number')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  const shut = await closedPort()
  const closed = await runProbeOnce({ type: PROBE_TCP, target: `127.0.0.1:${shut}`, timeoutMs: 2000 })
  assert.equal(closed.ok, false)
  assert.equal(closed.latencyMs, null)
  assert.equal(typeof closed.error, 'string')
})

test('the tcp probe rejects a target without a port instead of guessing 22', async () => {
  const result = await runProbeOnce({ type: PROBE_TCP, target: 'example.invalid', timeoutMs: 500 })
  assert.equal(result.ok, false)
  assert.match(result.error, /target must be host:port/)
})

test('an unknown probe type fails instead of running nothing', async () => {
  const result = await runProbeOnce({ type: 99, target: '127.0.0.1:1', timeoutMs: 200 })
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown probe type 99/)
  assert.equal(PROBE_ICMP, 3)
})

for (const backend of ['sqlite', 'json']) {
  test(`probe results are trimmed to the ring size and read back oldest first (${backend})`, () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-probe-'))
    let store
    try {
      store = openStore({ dshHome: home, keep: 10 })
      if (backend === 'json' && store.backend !== 'json') return
      if (backend === 'sqlite' && store.backend !== 'sqlite') return
      const id = store.upsertProbe({ name: 'api', type: PROBE_HTTP, target: 'http://127.0.0.1:1/', intervalSec: 60, timeoutMs: 1000 })
      assert.equal(typeof id, 'number')
      assert.equal(store.listProbes().length, 1)

      for (let index = 0; index < PROBE_KEEP + 5; index += 1) {
        store.insertProbeResult(id, { ts: 1000 + index, ok: index % 2 === 0, latencyMs: index, statusCode: 200 })
      }
      const grid = store.probeResults(id, PROBE_GRID)
      assert.equal(grid.length, PROBE_GRID)
      // Oldest first, and the newest cell is the last thing written.
      assert.equal(grid[grid.length - 1].ts, 1000 + PROBE_KEEP + 4)
      assert.ok(grid[0].ts < grid[grid.length - 1].ts)

      const latest = store.latestProbeResults().get(id)
      assert.equal(latest.ts, 1000 + PROBE_KEEP + 4)

      // Updating a probe keeps the same id rather than inserting a second row.
      store.upsertProbe({ id, name: 'api v2', type: PROBE_HTTP, target: 'http://127.0.0.1:1/', intervalSec: 120, timeoutMs: 1000 })
      assert.equal(store.listProbes().length, 1)
      assert.equal(store.listProbes()[0].name, 'api v2')
      assert.equal(store.listProbes()[0].intervalSec, 120)

      assert.equal(store.deleteProbe(id), true)
      assert.equal(store.listProbes().length, 0)
      assert.equal(store.probeResults(id).length, 0)
      assert.equal(store.deleteProbe(id), false)
    } finally {
      store?.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
}

test('a probe already in flight is not started twice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-probe-'))
  let store
  try {
    store = openStore({ dshHome: home, keep: 10 })
    const id = store.upsertProbe({ name: 'api', type: PROBE_TCP, target: '127.0.0.1:1', intervalSec: 60, timeoutMs: 5000 })
    const monitor = new ServiceMonitor({ store })
    const probe = store.listProbes().find(candidate => candidate.id === id)
    const [first, second] = await Promise.all([monitor.runProbe(probe), monitor.runProbe(probe)])
    assert.equal([first, second].filter(value => value !== null).length, 1)
    assert.equal(store.probeResults(id, PROBE_GRID).length, 1)
  } finally {
    store?.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('list() joins every probe with its newest reading and its grid', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-probe-'))
  let store
  try {
    store = openStore({ dshHome: home, keep: 10 })
    const id = store.upsertProbe({ name: 'api', type: PROBE_TCP, target: '127.0.0.1:1', intervalSec: 60, timeoutMs: 800 })
    const monitor = new ServiceMonitor({ store })
    const probe = store.listProbes().find(candidate => candidate.id === id)
    await monitor.runProbe(probe)
    const [row] = monitor.list()
    assert.equal(row.id, id)
    assert.equal(row.latest.ok, false)
    assert.equal(row.grid.length, 1)
    assert.equal(row.latest.ts, row.grid[0].ts)
  } finally {
    store?.close()
    rmSync(home, { recursive: true, force: true })
  }
})
