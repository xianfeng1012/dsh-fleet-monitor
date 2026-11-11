/**
 * Collector rollup tests.
 *
 * The collector is the only writer of the derived tables, and every one of them
 * is invisible until it is wrong: a bucket that merges instead of replacing
 * double-counts, a bucket that starts from zero after a restart shows a dip, a
 * peak temperature averaged into a mean hides the spike the alert rule exists to
 * catch, and a traffic delta computed across an outage reports a burst that never
 * happened. Each of those is a separate test below.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Collector } from '../lib/collector.js'
import { openStore } from '../lib/store.js'

/** Temp roots created by this file. */
const roots = []

/** Make a fresh temp directory that is cleaned up at the end. */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sm-collector-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A bucket-aligned base timestamp (exactly on a 5-minute boundary). */
const T0 = 1_700_000_100_000

/** Live config shaped like `readConfig()` output. */
const CONFIG = {
  intervalMs: 30_000,
  concurrency: 6,
  execTimeoutMs: 12_000,
  connectTimeoutMs: 15_000,
  dshHome: '',
  sshDir: '',
  agentSocket: '',
  includeTag: '',
  excludeAliases: [],
  cpuAlertPct: 85,
  memAlertPct: 90,
  diskAlertPct: 90,
  keep: 2880,
  announceToAgent: false,
  hosts: [],
}

/** The host every test polls. */
const HOST = {
  alias: 'an-01', host: '10.0.0.9', port: 22, user: 'root', source: 'panel', tags: [],
}

/**
 * Build a successful probe result.
 * @param ts - sample timestamp.
 * @param over - metric overrides.
 */
function probeResult(ts, over = {}) {
  return {
    ok: true,
    latencyMs: 12,
    metrics: {
      ts,
      load: [0.5, 0.4, 0.3],
      cpu: { cores: 4, model: 'Xeon', totalJiffies: 1_200, idleJiffies: 550 },
      mem: { usedBytes: 8_000, totalBytes: 16_000, swapUsedBytes: 0, swapTotalBytes: 0 },
      disk: { usedBytes: 5_000, totalBytes: 20_000 },
      net: { rxBytes: 1_000, txBytes: 2_000 },
      conn: { tcp: 10, udp: 2 },
      procs: 100,
      uptimeSec: 3_600,
      ctxSwitches: 1_000,
      os: { name: 'Ubuntu 24.04', kernel: '6.8.0', arch: 'x86_64' },
      ...over,
    },
  }
}

/** A collector wired to a fixed config. */
function makeCollector(store) {
  return new Collector({ getConfig: () => CONFIG, store })
}

/** Seed the baseline sample so the first `record` can derive rates. */
function seedBaseline(store, alias = HOST.alias, ts = T0 - 30_000) {
  store.insertSample(alias, {
    ts, cpuTotal: 1_000, cpuIdle: 500, rxBytes: 0, txBytes: 0,
    cpuPct: 50, memUsed: 1, memTotal: 2, diskUsed: 1, diskTotal: 2,
  })
}

test('a bucket averages its gauges and keeps the peak temperature', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 100 })
  const collector = makeCollector(store)
  try {
    seedBaseline(store)
    store.upsertHardware(HOST.alias, { ts: T0, tempMax: 60 })
    // total advances 200, idle 50 → 75 % busy; rx grows 1000 B over 30 s.
    collector.record(HOST, probeResult(T0 + 30_000), CONFIG)

    store.upsertHardware(HOST.alias, { ts: T0, tempMax: 91 })
    collector.record(HOST, probeResult(T0 + 60_000, {
      // total advances 200, idle 150 → 25 % busy.
      cpu: { cores: 4, model: 'Xeon', totalJiffies: 1_400, idleJiffies: 700 },
    }), CONFIG)

    const buckets = store.sample5m(HOST.alias, 0, 10)
    assert.equal(buckets.length, 1, 'both observations land in the same 5-minute bucket')
    assert.equal(buckets[0].ts, T0, 'the bucket is keyed by its aligned start')
    assert.equal(buckets[0].cpu_pct, 50, 'the mean of 75 % and 25 %')
    assert.equal(buckets[0].temp_max, 91, 'the peak wins, not the mean')
    assert.equal(buckets[0].mem_total, 16_000)
  } finally {
    collector.dispose()
    store.close()
  }
})

test('a new bucket flushes the previous one instead of merging into it', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 100 })
  const collector = makeCollector(store)
  try {
    seedBaseline(store)
    collector.record(HOST, probeResult(T0 + 30_000), CONFIG)
    collector.record(HOST, probeResult(T0 + 300_000, {
      cpu: { cores: 4, model: 'Xeon', totalJiffies: 1_400, idleJiffies: 700 },
    }), CONFIG)

    const buckets = store.sample5m(HOST.alias, 0, 10)
    assert.equal(buckets.length, 2, 'the clock crossing opened a second bucket')
    assert.equal(buckets[0].ts, T0 + 300_000, 'newest first')
    assert.equal(buckets[1].ts, T0)
    assert.equal(buckets[1].cpu_pct, 75, 'the first bucket kept its own value')
  } finally {
    collector.dispose()
    store.close()
  }
})

test('a restart resumes the bucket from the raw samples already on disk', async () => {
  const root = tempRoot()
  const first = await openStore({ dshHome: root, keep: 100 })
  const before = makeCollector(first)
  try {
    seedBaseline(first)
    before.record(HOST, probeResult(T0 + 30_000), CONFIG)
  } finally {
    before.dispose()
    first.close()
  }

  // A brand-new process: the in-memory bucket is gone, the raw sample is not.
  const second = await openStore({ dshHome: root, keep: 100 })
  const afterRestart = makeCollector(second)
  try {
    afterRestart.record(HOST, probeResult(T0 + 60_000, {
      cpu: { cores: 4, model: 'Xeon', totalJiffies: 1_400, idleJiffies: 700 },
    }), CONFIG)
    const buckets = second.sample5m(HOST.alias, 0, 10)
    assert.equal(buckets.length, 1)
    assert.equal(buckets[0].cpu_pct, 50, 'the pre-restart sample still counts toward the mean')
  } finally {
    afterRestart.dispose()
    second.close()
  }
})

test('daily traffic only counts a delta against a recent sample', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 100 })
  const collector = makeCollector(store)
  try {
    seedBaseline(store)
    collector.record(HOST, probeResult(T0 + 30_000), CONFIG)
    // A gap far longer than the freshness window, and long enough to cross a
    // local midnight: the counter difference spans the whole outage and must not
    // be booked as traffic on either day.
    collector.record(HOST, probeResult(T0 + 30_000 + 26 * 3_600_000, {
      net: { rxBytes: 9_000_000, txBytes: 9_000_000 },
    }), CONFIG)

    const rows = store.dailyStats('1970-01-01')
    assert.equal(rows.length, 2, 'two local days were touched')
    assert.equal(rows[0].rx_bytes, 1_000, 'only the fresh delta is booked')
    assert.equal(rows[0].tx_bytes, 2_000)
    assert.equal(rows[1].rx_bytes, 0, 'the post-gap sample books nothing')
    assert.equal(rows[1].samples, 1)
  } finally {
    collector.dispose()
    store.close()
  }
})

test('dispose flushes the open bucket', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 100 })
  const collector = makeCollector(store)
  try {
    seedBaseline(store)
    collector.record(HOST, probeResult(T0 + 30_000), CONFIG)
    collector.buckets.clear()
    collector.record(HOST, probeResult(T0 + 60_000, {
      cpu: { cores: 4, model: 'Xeon', totalJiffies: 1_400, idleJiffies: 700 },
    }), CONFIG)
    // Rebuilt from the raw table, so the whole bucket exists again.
    assert.equal(store.sample5m(HOST.alias, 0, 10)[0].cpu_pct, 50)
    collector.dispose()
    assert.equal(collector.buckets.size, 0)
    assert.equal(store.sample5m(HOST.alias, 0, 10)[0].cpu_pct, 50, 'the flush kept the value')
  } finally {
    store.close()
  }
})

test('an offline host keeps its row and writes no sample', async () => {
  const store = await openStore({ dshHome: tempRoot(), keep: 100 })
  const collector = makeCollector(store)
  try {
    collector.record(HOST, { ok: false, stage: 'connect', error: 'handshake timeout' }, CONFIG)
    collector.record(HOST, { ok: false, stage: 'skipped', error: 'excluded by config' }, CONFIG)
    const rows = store.latestAll()
    assert.equal(rows.length, 1, 'one node row, not two')
    assert.equal(rows[0].status, 'skipped', 'the latest status wins')
    assert.equal(store.history(HOST.alias, 0, 10).length, 0, 'no sample for a failed poll')
    assert.equal(store.sample5m(HOST.alias, 0, 10).length, 0, 'and no rollup either')
  } finally {
    collector.dispose()
    store.close()
  }
})
