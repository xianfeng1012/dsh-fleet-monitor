/**
 * Store contract tests.
 *
 * Both backends must present *one* interface and *one* row shape. The routes,
 * the tools and the collector all read `latestAll()` and `previous()` rows, so a
 * field-name drift between SQLite and the memory fallback would silently render
 * an empty panel on machines where SQLite is unavailable — which is exactly the
 * machine nobody is watching.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { openStore } from '../lib/store.js'

/** Temp roots created by this file. */
const roots = []

/** Make a fresh temp directory that is cleaned up at the end. */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sm-store-'))
  roots.push(dir)
  return dir
}

/** A complete node record. */
const NODE = {
  alias: 'web-01',
  host: '10.0.0.11',
  port: 22,
  user: 'deploy',
  source: 'dsh-ssh',
  status: 'online',
  lastOk: 1_700_000_030_000,
  latencyMs: 41,
  osName: 'Ubuntu 22.04.3 LTS',
  kernel: '5.15.0-91-generic',
  arch: 'x86_64',
  cores: 8,
  cpuModel: 'Xeon',
}

/** Build one sample row. */
function sampleRow(ts, cpuPct) {
  return {
    ts,
    cpuPct,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    memUsed: 8_000,
    memTotal: 16_000,
    swapUsed: 0,
    swapTotal: 0,
    diskUsed: 5_000,
    diskTotal: 10_000,
    rxBps: 1_024,
    txBps: 2_048,
    rxBytes: 1_000_000,
    txBytes: 2_000_000,
    tcp: 12,
    udp: 3,
    procs: 180,
    uptimeSec: 86_400,
    cpuTotal: 100_000,
    cpuIdle: 60_000,
    ctxSwitches: 5_000,
  }
}

/**
 * Exercise the shared contract against one backend.
 * @param store - an open store.
 */
function exercise(store) {
  store.upsertNode(NODE)
  store.upsertNode({ ...NODE, alias: 'db-01', host: '10.0.0.12', source: 'ssh-config' })

  store.insertSample('web-01', sampleRow(1_700_000_000_000, 12.5))
  store.insertSample('web-01', sampleRow(1_700_000_030_000, 48.25))
  store.insertSample('db-01', sampleRow(1_700_000_030_000, 91))

  // previous() must be the newest row, with the SQL column names.
  const previous = store.previous('web-01')
  assert.equal(previous.ts, 1_700_000_030_000)
  assert.equal(previous.cpu_pct, 48.25)
  assert.equal(previous.cpu_total, 100_000, 'raw counters survive the round-trip')
  assert.equal(previous.cpu_idle, 60_000)
  assert.equal(previous.ctx_switches, 5_000)
  assert.equal(previous.mem_total, 16_000)

  // latestAll() joins each node to its newest sample.
  const latest = store.latestAll()
  assert.equal(latest.length, 2)
  const byAlias = Object.fromEntries(latest.map((row) => [row.alias, row]))
  assert.equal(byAlias['web-01'].status, 'online')
  assert.equal(byAlias['web-01'].sample_ts, 1_700_000_030_000)
  assert.equal(byAlias['web-01'].cpu_pct, 48.25)
  assert.equal(byAlias['db-01'].cpu_pct, 91)
  assert.equal(byAlias['db-01'].source, 'ssh-config')

  // history() is newest-first and honours the window.
  const all = store.history('web-01', 0, 100)
  assert.equal(all.length, 2)
  assert.equal(all[0].ts, 1_700_000_030_000, 'newest first')
  assert.equal(all[1].ts, 1_700_000_000_000)
  const recent = store.history('web-01', 1_700_000_020_000, 100)
  assert.equal(recent.length, 1, 'the window excludes the older sample')
  const capped = store.history('web-01', 0, 1)
  assert.equal(capped.length, 1)
  assert.equal(capped[0].ts, 1_700_000_030_000, 'the limit keeps the newest')

  // forget() drops the node and its history.
  store.forget('db-01')
  assert.equal(store.latestAll().length, 1)
  assert.equal(store.history('db-01', 0, 100).length, 0)
}

before(() => {})

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('the live backend satisfies the contract', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 10 })
  try {
    assert.ok(store.backend === 'sqlite' || store.backend === 'json')
    exercise(store)
  } finally {
    store.close()
  }
})

test('retention prunes the tail to `keep` samples', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 10 })
  try {
    store.upsertNode(NODE)
    for (let i = 0; i < 14; i += 1) {
      store.insertSample('web-01', sampleRow(1_700_000_000_000 + i * 30_000, i))
    }
    const rows = store.history('web-01', 0, 1000)
    assert.equal(rows.length, 10, 'only the newest `keep` samples survive')
    assert.equal(rows[0].cpu_pct, 13, 'the newest sample is retained')
    assert.equal(rows[9].cpu_pct, 4, 'the oldest samples were dropped')
  } finally {
    store.close()
  }
})

test('an unusable DSH home degrades to the memory backend instead of throwing', async () => {
  const root = tempRoot()
  // A *file* where the store expects a directory: mkdir fails, so the plugin
  // must fall back rather than take the whole host down with it.
  const blocked = join(root, 'not-a-directory')
  writeFileSync(blocked, 'x')
  const store = await openStore({ dshHome: blocked, keep: 10 })
  try {
    assert.equal(store.backend, 'json')
    assert.equal(typeof store.reason, 'string')
    exercise(store)
  } finally {
    store.close()
  }
})

test('samples written twice at the same timestamp collapse to one row', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 10 })
  try {
    store.upsertNode(NODE)
    store.insertSample('web-01', sampleRow(1_700_000_000_000, 10))
    store.insertSample('web-01', sampleRow(1_700_000_000_000, 20))
    const rows = store.history('web-01', 0, 100)
    assert.equal(rows.length, 1, 'the (alias, ts) key is the interval identity')
    assert.equal(rows[0].cpu_pct, 20, 'the later write wins')
  } finally {
    store.close()
  }
})
