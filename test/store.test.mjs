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
import { createRequire } from 'node:module'
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

/**
 * Exercise the analytics tables against one backend.
 *
 * These are the tables the rollups, the metadata layer and the slow probe read,
 * so both backends have to answer with the same shapes even though only SQLite
 * keeps 30 days of them.
 *
 * @param store - an open store.
 */
function exerciseAnalytics(store) {
  // A dedicated alias: this helper must not depend on what `exercise` left
  // behind, so both can run against the same store in either order.
  const alias = 'an-01'
  store.upsertNode({ ...NODE, alias, host: '10.0.0.21' })
  store.insertSample(alias, sampleRow(1_700_000_000_000, 10))

  // A bucket is written whole, and writing the same bucket twice replaces it
  // rather than merging: the collector accumulates in memory, so a merge here
  // would double-count after a restart rebuilt the bucket from raw samples.
  store.upsertSample5m(alias, { ts: 1_700_000_100_000, cpuPct: 20, memUsed: 1, memTotal: 2, rxBps: 10 })
  store.upsertSample5m(alias, { ts: 1_700_000_100_000, cpuPct: 33, memUsed: 1, memTotal: 2, rxBps: 30 })
  store.upsertSample5m(alias, { ts: 1_700_000_400_000, cpuPct: 40 })
  const buckets = store.sample5m(alias, 0, 10)
  assert.equal(buckets.length, 2, 'the bucket key is (alias, ts)')
  assert.equal(buckets[0].ts, 1_700_000_400_000, 'newest first')
  assert.equal(buckets[1].cpu_pct, 33, 'the later write wins')

  // Rebuilding a bucket after a restart reads the raw samples of that window.
  const raw = store.bucketSamples(alias, 1_700_000_000_000)
  assert.equal(raw.length, 1)
  assert.equal(raw[0].cpu_pct, 10)

  // Daily rows accumulate one observation at a time.
  store.bumpDaily(alias, '2026-11-11', { up: true, rxBytes: 100, txBytes: 200 })
  store.bumpDaily(alias, '2026-11-11', { up: false, rxBytes: 50, txBytes: 25 })
  store.bumpDaily(alias, '2026-11-12', { up: true, rxBytes: 7, txBytes: 9 })
  const daily = store.dailyStats('2026-11-01')
  assert.equal(daily.length, 2, 'one row per (alias, day)')
  assert.equal(daily[0].day, '2026-11-11', 'oldest day first')
  assert.equal(daily[0].samples, 2)
  assert.equal(daily[0].up_samples, 1)
  assert.equal(daily[0].rx_bytes, 150)
  assert.equal(daily[0].tx_bytes, 225)
  store.pruneDaily('2026-11-12')
  assert.equal(store.dailyStats('2026-11-01').length, 1, 'the cutoff day is kept')

  // Metadata is operator intent and outlives the measurement rows.
  store.upsertMeta({
    alias, displayName: 'An One', groupName: 'edge',
    tags: ['prod', 'eu'], note: 'primary', displayIndex: 2, hidden: true,
  })
  const meta = store.listMeta().filter((row) => row.alias === alias)
  assert.equal(meta.length, 1)
  assert.equal(meta[0].displayName, 'An One')
  assert.deepEqual(meta[0].tags, ['prod', 'eu'])
  assert.equal(meta[0].hidden, true)
  store.deleteMeta(alias)
  assert.equal(store.listMeta().filter((row) => row.alias === alias).length, 0)

  // The slow probe snapshot is replaced whole, never merged.
  store.upsertHardware(alias, {
    ts: 1_700_000_500_000, tempMax: 55.5,
    sensors: [{ name: 'coretemp', temperature: 55.5 }],
    gpu: { util: 12, memUsed: 100, memTotal: 1000, name: 'RTX' },
    listenPorts: 14, partitions: [{ mount: '/', used: 1, total: 2 }], nics: [{ name: 'eth0' }],
  })
  const hardware = store.hardwareFor(alias)
  assert.equal(hardware.tempMax, 55.5)
  assert.equal(hardware.gpu.util, 12)
  assert.equal(hardware.listenPorts, 14)
  assert.equal(hardware.partitions[0].mount, '/')
  assert.equal(store.listHardware().filter((row) => row.alias === alias).length, 1)
  store.upsertHardware(alias, { ts: 1_700_000_600_000, error: 'timed out' })
  const replaced = store.hardwareFor(alias)
  assert.equal(replaced.error, 'timed out')
  assert.equal(replaced.gpu, null, 'a failed sweep clears the stale snapshot')
  assert.deepEqual(replaced.sensors, [])

  // Availability is counted from the samples themselves, so it must agree with
  // how many rows the same store was given in each clock hour.
  const hour = Math.floor(1_700_000_000_000 / 3_600_000)
  for (let index = 1; index < 4; index += 1) {
    store.insertSample(alias, sampleRow(1_700_000_000_000 + index * 30_000, 10))
  }
  store.insertSample(alias, sampleRow(1_700_000_000_000 + 3_600_000, 10))
  const coverage = store.hourlyCoverage(1_700_000_000_000)
  assert.equal(coverage.get(alias).length, 2, 'two clock hours were touched')
  const first = coverage.get(alias).find((item) => item.hour === hour)
  assert.equal(first.samples, 4)
  assert.equal(
    store.hourlyCoverage(1_700_000_000_000 + 3_600_000).get(alias).length,
    1,
    'the window is exclusive on the left',
  )
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
    exerciseAnalytics(store)
  } finally {
    store.close()
  }
})

test('a hardware row with an impossible timestamp is read back, not thrown', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 10 })
  try {
    assert.equal(store.backend, 'sqlite')
    store.upsertHardware('web-01', {
      ts: Date.now(), tempMax: 41, sensors: [], gpu: null, listenPorts: 3,
      listenList: [22, 80, 443], partitions: [], nics: [], error: null,
    })

    // Exactly the shape a busybox `date +%s%3N` produces: epoch seconds followed
    // by nine nanoseconds. node:sqlite refuses to convert a number this large,
    // so reading it back used to throw from inside the sweep.
    store.db.exec("UPDATE host_hardware SET ts = 1794418402105374976 WHERE alias = 'web-01'")
    const row = store.hardwareFor('web-01')
    assert.equal(row.ts, 1794418402105)
    assert.equal(row.listenPorts, 3)
    assert.equal(store.listHardware().length, 1)
  } finally {
    store.close()
  }
})

test('the analytics tables answer identically on both backends', async () => {
  const sqlite = await openStore({ dshHome: tempRoot(), keep: 10 })
  try {
    assert.equal(sqlite.backend, 'sqlite')
    exerciseAnalytics(sqlite)
  } finally {
    sqlite.close()
  }

  const root = tempRoot()
  const blocked = join(root, 'not-a-directory')
  writeFileSync(blocked, 'x')
  const json = await openStore({ dshHome: blocked, keep: 10 })
  try {
    assert.equal(json.backend, 'json')
    exerciseAnalytics(json)
  } finally {
    json.close()
  }
})

test('a sample table from an older version is migrated in place', async () => {
  const root = tempRoot()
  // Build a current database, then strip the columns a v1 install would not
  // have. That is the exact state an operator upgrading the plugin has on disk.
  const first = await openStore({ dshHome: root, keep: 10 })
  assert.equal(first.backend, 'sqlite')
  first.upsertNode(NODE)
  first.insertSample('web-01', sampleRow(1_700_000_000_000, 42))
  first.close()

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(join(root, 'dsh-fleet-monitor.sqlite'))
  for (const column of ['temp_max', 'gpu_util', 'gpu_mem_used', 'gpu_mem_total', 'listen_ports']) {
    db.exec(`ALTER TABLE sample DROP COLUMN ${column}`)
  }
  db.close()

  const upgraded = await openStore({ dshHome: root, keep: 10 })
  try {
    assert.equal(upgraded.backend, 'sqlite')
    assert.deepEqual(
      [...upgraded.migratedColumns].sort(),
      ['gpu_mem_total', 'gpu_mem_used', 'gpu_util', 'listen_ports', 'temp_max'],
      'every column the new code needs is appended, and reported',
    )
    const kept = upgraded.history('web-01', 0, 10)
    assert.equal(kept.length, 1, 'the pre-migration row survives')
    assert.equal(kept[0].cpu_pct, 42)
    assert.equal(kept[0].temp_max, null, 'the appended column reads as null, not 0')
  } finally {
    upgraded.close()
  }

  // Reopening must not re-append anything: the migration has to be idempotent or
  // every start would report phantom work.
  const again = await openStore({ dshHome: root, keep: 10 })
  try {
    assert.deepEqual(again.migratedColumns, [])
  } finally {
    again.close()
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
