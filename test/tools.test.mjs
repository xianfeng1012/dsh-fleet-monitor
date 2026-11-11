/**
 * Tool contract tests.
 *
 * Two separate things are checked here: the `output` block the host demands,
 * and the fact that a column missing from an older sample travels as null
 * rather than NaN. NaN survives JSON into a model's context as the literal
 * token NaN, which is worse than saying "not measured".
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeTools } from '../lib/tools.js'

const snapshot = {
  lastRunAt: 1_790_000_000_000,
  intervalMs: 30_000,
  backend: 'sqlite',
  problems: [],
  nodes: [
    {
      alias: 'web-01',
      host: '10.0.0.11',
      status: 'online',
      alerts: [],
      latencyMs: 42,
      lastError: null,
      cpuPct: 12.34,
      load: [0.42, 0.31, 0.2],
      mem: { used: 1_073_741_824, total: 2_147_483_648, pct: 50 },
      disk: { used: 10_737_418_240, total: 42_949_672_960, pct: 25 },
      net: { rxBps: 2048, txBps: 512 },
      conn: { tcp: 12 },
      procs: 148,
      uptimeSec: 5 * 86_400,
      os: { name: 'Ubuntu 24.04 LTS' },
    },
  ],
}

function toolsFor(history) {
  const collector = { snapshot: () => snapshot, refresh: async () => snapshot }
  const store = {
    backend: 'json',
    history,
    listAlertRules: () => [],
    listEvents: () => [],
    listCronTasks: () => [],
    listCronRuns: () => [],
    hardwareFor: () => null,
    listMeta: () => [],
  }
  const services = { list: () => [] }
  const alerts = {}
  return Object.fromEntries(
    makeTools({ collector, store, services, alerts }).map(tool => [tool.name, tool]),
  )
}

test('every tool declares the output block the host validates', async () => {
  const tools = toolsFor(() => [])
  assert.equal(Object.keys(tools).length, 7)
  for (const tool of Object.values(tools)) {
    assert.equal(typeof tool.output, 'object', `${tool.name} must declare output`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} must declare output.render`)
    assert.equal(typeof tool.output.schema, 'object', `${tool.name} must declare output.schema`)
    assert.ok(Array.isArray(tool.output.render({}, await tool.execute({ alias: 'web-01' }))))
  }
})

test('the probe and alert readers disappear when their engines do', () => {
  const collector = { snapshot: () => snapshot, refresh: async () => snapshot }
  const store = { backend: 'json', history: () => [] }
  const names = makeTools({ collector, store }).map(tool => tool.name).sort()
  // Only the three tools that need nothing but the collector and the store are
  // unconditional. A tool that exists and always answers "not available" cannot
  // be told apart from a broken one by the model reading it.
  assert.deepEqual(names, ['fleet_history', 'fleet_host', 'fleet_refresh', 'fleet_snapshot', 'fleet_tasks'])
})

test('the host reader rounds percentages instead of printing a raw float', async () => {
  const collector = {
    snapshot: () => ({
      nodes: [{ ...snapshot.nodes[0], mem: { pct: 54.78847450691375 }, disk: { pct: 35.232488765077655 } }],
    }),
  }
  const store = { hardwareFor: () => null, listMeta: () => [] }
  const tool = makeTools({ collector, store }).find(entry => entry.name === 'fleet_host')
  const value = await tool.execute({ alias: 'web-01' })
  const body = tool.output.render({}, value).map(block => block.text).join('\n')
  // A model reading "54.78847450691375%" will quote it back verbatim.
  assert.ok(body.includes('mem 54.8%'), body)
  assert.ok(body.includes('disk 35.2%'), body)
  assert.ok(!body.includes('54.78847450691375'), body)
})

test('the probe reader tolerates a probe that has never run', async () => {
  const collector = { snapshot: () => snapshot }
  const store = {
    listAlertRules: () => [],
    listEvents: () => [],
    listCronTasks: () => [],
    listCronRuns: () => [],
    hardwareFor: () => null,
    listMeta: () => [],
  }
  // `list()` reports the last sample as `latest` and the ring as `grid`; a probe
  // that has never fired has neither, and reading `.results` here used to throw.
  const services = { list: () => [{ id: 1, name: 'p', type: 2, target: '127.0.0.1:1', intervalSec: 60, enabled: true }] }
  const tool = makeTools({ collector, store, services }).find(entry => entry.name === 'fleet_services')
  const value = await tool.execute({})
  assert.equal(value.probes[0].ok, null)
  assert.equal(value.probes[0].sampled, 0)
  const body = tool.output.render({}, value).map(block => block.text).join('\n')
  assert.ok(body.includes('never'), body)
})

test('a sample that predates a column yields null, never NaN', async () => {
  // An older JSON snapshot has no rx_bps/tx_bps column at all. Math.round of
  // undefined is NaN and NaN is what the model would have read.
  const tools = toolsFor(() => [{ ts: 1_790_000_000_000, cpu_pct: 12.5, load1: 0.4 }])
  const value = await tools.fleet_history.execute({ alias: 'web-01' })

  assert.equal(value.points.length, 1)
  assert.equal(value.points[0].rxBps, null, 'missing rx_bps is a missing measurement')
  assert.equal(value.points[0].txBps, null)
  assert.equal(value.points[0].cpuPct, 12.5)
  assert.ok(!JSON.stringify(value).includes('NaN'), 'NaN must never reach the transcript')

  const rendered = tools.fleet_history.output.render({}, value)
    .map(block => block.text)
    .join('\n')
  assert.ok(!rendered.includes('NaN'))
  assert.match(rendered, /web-01/)
  assert.match(rendered, /12\.5%/)
})

test('an empty window says so instead of rendering a bare header', async () => {
  const tools = toolsFor(() => [])
  const value = await tools.fleet_history.execute({ alias: 'web-01' })
  assert.deepEqual(value.points, [])
  assert.match(value.note, /no samples/)

  const rendered = tools.fleet_history.output.render({}, value).map(block => block.text).join('\n')
  assert.match(rendered, /no samples/)
})

test('the snapshot render names the offline hosts and their errors', async () => {
  const offline = {
    ...snapshot,
    nodes: [
      {
        ...snapshot.nodes[0],
        alias: 'db-01',
        status: 'offline',
        alerts: ['host unreachable'],
        lastError: 'Timed out while waiting for handshake',
        cpuPct: null,
        mem: { used: 0, total: 0, pct: null },
        disk: { used: 0, total: 0, pct: null },
        net: { rxBps: null, txBps: null },
        conn: { tcp: null },
        procs: null,
        uptimeSec: null,
        os: { name: '' },
      },
    ],
  }
  const tools = Object.fromEntries(
    makeTools({ collector: { snapshot: () => offline, refresh: async () => offline }, store: { backend: 'sqlite', history: () => [] } })
      .map(tool => [tool.name, tool]),
  )
  const value = await tools.fleet_snapshot.execute({})
  const rendered = tools.fleet_snapshot.output.render({}, value).map(block => block.text).join('\n')

  assert.match(rendered, /ALIAS\s+STATUS/)
  assert.match(rendered, /db-01\s+offline/)
  assert.match(rendered, /host unreachable/)
  assert.match(rendered, /Timed out while waiting for handshake/)
})
