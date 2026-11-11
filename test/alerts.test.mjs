/**
 * Alert evaluation: the parts that decide whether a page fires, and the parts
 * that decide whether it fires twice.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AlertEngine, METRIC_NAMES, describeBreach, inScope, metricValue, roundsFor } from '../lib/alerts.js'
import { openStore } from '../lib/store.js'

/** One host in the shape `collector.shapeRow` produces. */
function node(overrides = {}) {
  return {
    alias: 'web-01',
    host: '10.0.0.11',
    status: 'online',
    cpuPct: 10,
    load: [0.2, 0.3, 0.4],
    mem: { used: 1_000, total: 4_000, pct: 25 },
    swap: { used: 0, total: 0 },
    disk: { used: 30_000, total: 100_000, pct: 30 },
    net: { rxBps: 100, txBps: 200 },
    conn: { tcp: 12, udp: 3 },
    procs: 140,
    tempMax: null,
    gpuUtil: null,
    ...overrides,
  }
}

/** A store in a throwaway directory, closed after the test. */
function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-alerts-'))
  const store = openStore({ dshHome: dir, keep: 100 })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** An engine reading a fixed interval, started so state restore runs. */
function makeEngine(t, store, intervalMs = 30_000) {
  const engine = new AlertEngine({ store, config: () => ({ intervalMs }) })
  engine.start()
  t.after(() => engine.dispose())
  return engine
}

/** A channel pointed at a local server, plus a group that owns it. */
async function makeChannel(t, store) {
  const received = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      received.push(body)
      response.writeHead(200)
      response.end('ok')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const channelId = store.upsertNotifyChannel({ name: 'test', url: `http://127.0.0.1:${port}/hook`, method: 'POST', bodyType: 'json', headers: '{}', body: '{"text":"#MESSAGE#"}' })
  const groupId = store.upsertNotifyGroup({ name: 'ops', channelIds: [channelId] })
  return { channelId, groupId, received }
}

test('a duration becomes consecutive rounds at the live interval', () => {
  assert.equal(roundsFor({ metric: 'cpu', durationSec: 180 }, 30_000), 6)
  assert.equal(roundsFor({ metric: 'cpu', durationSec: 180 }, 10_000), 18, 'a faster interval needs more rounds')
  assert.equal(roundsFor({ metric: 'cpu', durationSec: 60 }, 30_000), 2)
  assert.equal(roundsFor({ metric: 'offline', durationSec: 1 }, 30_000), 2, 'one missed sweep is not an outage')
  assert.equal(roundsFor({ metric: 'cpu', durationSec: 30 }, 0), 1, 'a zero interval falls back instead of dividing by zero')
})

test('scope decides which hosts a rule touches', () => {
  assert.equal(inScope({ mode: 'all', aliases: [] }, 'web-01'), true)
  assert.equal(inScope({ mode: 'include', aliases: ['web-01'] }, 'web-01'), true)
  assert.equal(inScope({ mode: 'include', aliases: ['web-02'] }, 'web-01'), false)
  assert.equal(inScope({ mode: 'include', aliases: [] }, 'web-01'), false, 'an empty include list matches nothing')
  assert.equal(inScope({ mode: 'exclude', aliases: ['web-01'] }, 'web-01'), false)
  assert.equal(inScope(undefined, 'web-01'), true)
})

test('the metric table reads null where there is no reading, never zero', () => {
  assert.equal(metricValue('cpu', node()), 10)
  assert.equal(metricValue('memory', node()), 25)
  assert.equal(metricValue('disk', node()), 30)
  assert.equal(metricValue('load5', node()), 0.3)
  assert.equal(metricValue('net_all_speed', node()), 300)
  assert.equal(metricValue('process_count', node()), 140)
  assert.equal(metricValue('offline', node()), 0)
  assert.equal(metricValue('offline', node({ status: 'offline' })), 1)

  // Everything below is "this host cannot answer", which must not read as zero.
  assert.equal(metricValue('swap', node()), null, 'no swap is not 0% swap')
  assert.equal(metricValue('temperature_max', node()), null, 'no sensor is not 0°C')
  assert.equal(metricValue('gpu', node()), null, 'no GPU is not 0% utilisation')
  assert.equal(metricValue('cpu', node({ cpuPct: null })), null)
  assert.equal(metricValue('cpu', node({ cpuPct: Number.NaN })), null, 'NaN never reaches a comparison')

  const transfers = new Map([['web-01', { rx: 2 * 1024 ** 3, tx: 1 * 1024 ** 3 }]])
  assert.equal(metricValue('transfer_in', node(), transfers), 2)
  assert.equal(metricValue('transfer_all', node(), transfers), 3)
  assert.equal(metricValue('transfer_in', node(), new Map()), null)
})

test('a rule fires only after the full duration, and only once', async (t) => {
  const store = makeStore(t)
  const engine = makeEngine(t, store)
  store.upsertAlertRule({ name: 'cpu high', metric: 'cpu', threshold: 80, durationSec: 180, cooldownSec: 0 })
  engine.reload()
  const hot = node({ cpuPct: 95 })
  for (let round = 0; round < 5; round += 1) await engine.evaluate([hot])
  assert.equal(store.listEvents().length, 0, '5 of 6 rounds is not yet a breach')
  await engine.evaluate([hot])
  const events = store.listEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].state, 'firing')
  assert.equal(events[0].alias, 'web-01')
  assert.equal(events[0].peak, 95)
  await engine.evaluate([hot])
  assert.equal(store.listEvents().length, 1, 'staying in breach does not open a second event')
})

test('recovery closes the event, and the next breach opens a new one', async (t) => {
  const store = makeStore(t)
  const engine = makeEngine(t, store)
  store.upsertAlertRule({ name: 'cpu high', metric: 'cpu', threshold: 80, durationSec: 60, cooldownSec: 3600 })
  engine.reload()
  const hot = node({ cpuPct: 95 })
  const cool = node({ cpuPct: 5 })
  await engine.evaluate([hot]); await engine.evaluate([hot])
  assert.equal(store.listEvents()[0].state, 'firing')
  await engine.evaluate([cool])
  const closed = store.listEvents()
  assert.equal(closed.length, 1)
  assert.equal(closed[0].state, 'resolved')
  assert.ok(typeof closed[0].endedAt === 'number')
  await engine.evaluate([hot]); await engine.evaluate([hot])
  assert.equal(store.listEvents().length, 2, 'a new episode is a new event')
})

test('a missing reading freezes the state instead of resolving it', async (t) => {
  const store = makeStore(t)
  const engine = makeEngine(t, store)
  store.upsertAlertRule({ name: 'swap high', metric: 'swap', threshold: 50, durationSec: 60 })
  engine.reload()
  const swapped = node({ swap: { used: 3_000, total: 4_000 } })
  await engine.evaluate([swapped]); await engine.evaluate([swapped])
  assert.equal(store.listEvents()[0].state, 'firing')
  // One sweep with no swap reading (an SSH timeout looks exactly like this).
  await engine.evaluate([node({ swap: { used: null, total: null } })])
  assert.equal(store.listEvents().length, 1)
  assert.equal(store.listEvents()[0].state, 'firing', 'a timeout is not a recovery')
})

test('restarting resumes firing without opening a duplicate event', async (t) => {
  const store = makeStore(t)
  const first = makeEngine(t, store)
  store.upsertAlertRule({ name: 'cpu high', metric: 'cpu', threshold: 80, durationSec: 60 })
  first.reload()
  const hot = node({ cpuPct: 95 })
  await first.evaluate([hot]); await first.evaluate([hot])
  assert.equal(store.listEvents().length, 1)
  first.dispose()

  const second = makeEngine(t, store)
  await second.evaluate([hot])
  assert.equal(store.listEvents().length, 1, 'the reopened event is adopted, not duplicated')
})

test('the cooldown suppresses a flap but never a recovery', async (t) => {
  const store = makeStore(t)
  const engine = makeEngine(t, store)
  const { groupId, received } = await makeChannel(t, store)
  store.upsertAlertRule({ name: 'cpu high', metric: 'cpu', threshold: 80, durationSec: 60, cooldownSec: 3600, notifyGroupId: groupId })
  engine.reload()
  const hot = node({ cpuPct: 95 })
  const cool = node({ cpuPct: 5 })

  await engine.evaluate([hot]); await engine.evaluate([hot])
  assert.equal(received.length, 1, 'the first breach notifies')
  await engine.evaluate([cool])
  assert.equal(received.length, 2, 'recovery always notifies')
  await engine.evaluate([hot]); await engine.evaluate([hot])
  assert.equal(received.length, 2, 'a breach inside the cooldown stays quiet')
  assert.equal(store.listEvents().length, 2, 'but the event is still recorded')
})

test('silencing suppresses the page without hiding the event', async (t) => {
  const store = makeStore(t)
  const engine = makeEngine(t, store)
  const { groupId, received } = await makeChannel(t, store)
  store.upsertAlertRule({ name: 'cpu high', metric: 'cpu', threshold: 80, durationSec: 60, cooldownSec: 0, notifyGroupId: groupId })
  engine.reload()
  engine.silence(null, 'web-01', 30)
  const hot = node({ cpuPct: 95 })
  await engine.evaluate([hot]); await engine.evaluate([hot])
  assert.equal(received.length, 0)
  assert.equal(store.listEvents().length, 1, 'the event is recorded while silenced')
  assert.equal(engine.isSilenced(1, 'web-01'), true)
  assert.equal(engine.isSilenced(1, 'web-02'), false)
})

test('more than five messages in one sweep collapse into a digest', async (t) => {
  const store = makeStore(t)
  const engine = makeEngine(t, store)
  const { groupId, received } = await makeChannel(t, store)
  store.upsertAlertRule({ name: 'cpu high', metric: 'cpu', threshold: 80, durationSec: 60, cooldownSec: 0, notifyGroupId: groupId })
  engine.reload()
  const fleet = Array.from({ length: 9 }, (_, index) => node({ alias: `web-0${index}`, cpuPct: 95 }))
  await engine.evaluate(fleet); await engine.evaluate(fleet)
  assert.ok(received.length < 9, `expected a digest, got ${received.length} messages`)
  assert.ok(received.some((body) => body.includes('more events')), 'the tail is summarised')
})

test('a threshold below the reading only fires in the direction the rule asks for', async (t) => {
  const store = makeStore(t)
  const engine = makeEngine(t, store)
  store.upsertAlertRule({ name: 'free disk', metric: 'disk', op: 'lt', threshold: 20, durationSec: 60 })
  engine.reload()
  await engine.evaluate([node({ disk: { used: 10_000, total: 100_000, pct: 10 } })])
  await engine.evaluate([node({ disk: { used: 10_000, total: 100_000, pct: 10 } })])
  assert.equal(store.listEvents().length, 1)
  assert.equal(store.listEvents()[0].state, 'firing')
})

test('the breach description names the host, the metric and the threshold', () => {
  const rule = { metric: 'cpu', threshold: 85, op: 'gt' }
  assert.equal(describeBreach(rule, node({ cpuPct: 91.44 }), 91.44), 'web-01 cpu 91.44 > 85')
  assert.equal(describeBreach({ metric: 'offline', threshold: 0 }, node({ status: 'offline' }), 1), 'web-01 is offline')
})

test('every advertised metric has a reader', () => {
  for (const metric of METRIC_NAMES) {
    assert.ok(Object.hasOwn({ ...metricValue }, metric) === false || typeof metricValue(metric, node()) !== 'undefined', metric)
  }
  assert.equal(METRIC_NAMES.length, 19)
  assert.ok(METRIC_NAMES.includes('offline'))
  assert.ok(!METRIC_NAMES.includes('gpu_max'), 'a metric with no reader would never fire')
})
