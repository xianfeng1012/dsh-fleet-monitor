/**
 * Slow-probe parsing tests.
 *
 * The slow probe is the only source of temperature, GPU, listening ports and the
 * per-partition breakdown, and it runs against hundreds of unknown machines. What
 * is tested here is the acceptance rule: a payload that finished is parsed fully,
 * a payload that did not finish says so instead of reporting "no sensors", and a
 * non-Linux host is named as such rather than silently reading as healthy.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SLOW_SCRIPT, epochMillis, parseSlow } from '../lib/probe-slow.js'

test('the remote clock is placed on the millisecond scale whatever it printed', () => {
  // A host whose date reads the %3N width suffix as part of %N answers with
  // epoch seconds followed by nine nanoseconds.
  assert.equal(epochMillis('1794418402105374976'), 1794418402105)
  assert.equal(epochMillis('1794418402105'), 1794418402105)
  assert.equal(epochMillis('1794418402'), 1794418402000)
  assert.ok(epochMillis('') > 0, 'a missing clock falls back to now')
  assert.ok(epochMillis('0') > 0)
  assert.ok(epochMillis('garbage') > 0)
})

test('a nanosecond timestamp in the payload is stored as milliseconds', () => {
  const parsed = parseSlow(`slow_ok=1\nts=1794418402105374976\nuname_s=Linux\nslow_done=1\n`)
  assert.equal(parsed.ts, 1794418402105)
})


/** A complete payload from a Linux host with sensors, a GPU and two partitions. */
const FULL = [
  'ts=1700000000000',
  'uname_s=Linux',
  'slow_ok=1',
  'temp_0=coretemp:55.0',
  'temp_1=cpu_thermal:62.5',
  'gpu_util=12',
  'gpu_mem_used=1024',
  'gpu_mem_total=8192',
  'gpu_name=NVIDIA GeForce RTX 3080',
  'listen_count=3',
  'listen_0=22',
  'listen_1=80',
  'listen_2=443',
  'part_0=/|123456|456789',
  'part_1=/data|10|20',
  'nic_0=eth0|100000|200000',
  'nic_1=wlan0|5|6',
  'slow_done=1',
  '',
].join('\n')

test('the script is POSIX sh, not bash', () => {
  assert.ok(SLOW_SCRIPT.includes('set -u'))
  for (const bashism of ['[[', 'local ', 'echo -e', 'function ']) {
    assert.equal(SLOW_SCRIPT.includes(bashism), false, `must not use ${bashism}`)
  }
  assert.ok(SLOW_SCRIPT.includes('slow_done=1'), 'a finished payload is self-marking')
})

test('a complete payload is parsed into the hardware snapshot', () => {
  const parsed = parseSlow(FULL)
  assert.equal(parsed.complete, true)
  assert.equal(parsed.reason, '')
  assert.equal(parsed.ts, 1_700_000_000_000)
  assert.equal(parsed.tempMax, 62.5, 'the hottest sensor wins')
  assert.deepEqual(parsed.sensors, [
    { name: 'coretemp', temperature: 55 },
    { name: 'cpu_thermal', temperature: 62.5 },
  ])
  assert.deepEqual(parsed.gpu, {
    util: 12, memUsed: 1024, memTotal: 8192, name: 'NVIDIA GeForce RTX 3080',
  })
  assert.equal(parsed.listenPorts, 3)
  assert.deepEqual(parsed.listenList, [22, 80, 443])
  assert.deepEqual(parsed.partitions[1], { mount: '/data', used: 10, total: 20 })
  assert.deepEqual(parsed.nics[0], { name: 'eth0', rxBytes: 100_000, txBytes: 200_000 })
})

test('a host without sensors or a GPU is a normal host, not an error', () => {
  const parsed = parseSlow([
    'ts=1700000000000', 'uname_s=Linux', 'slow_ok=1',
    'listen_count=1', 'listen_0=22', 'slow_done=1',
  ].join('\n'))
  assert.equal(parsed.complete, true)
  assert.equal(parsed.tempMax, null)
  assert.deepEqual(parsed.sensors, [])
  assert.equal(parsed.gpu, null)
  assert.deepEqual(parsed.partitions, [])
  assert.deepEqual(parsed.nics, [])
})

test('a payload that never finished is reported as unfinished', () => {
  const truncated = FULL.split('\n').slice(0, 8).join('\n')
  const parsed = parseSlow(truncated)
  assert.equal(parsed.complete, false)
  assert.match(parsed.reason, /did not run the hardware probe to completion/)
  assert.equal(parsed.tempMax, null, 'partial data is not presented as a reading')
  assert.deepEqual(parsed.sensors, [])
})

test('a non-Linux host names the limitation instead of pretending', () => {
  const parsed = parseSlow(['ts=1700000000001', 'uname_s=FreeBSD', 'slow_done=1'].join('\n'))
  assert.equal(parsed.complete, false)
  assert.match(parsed.reason, /Linux only \(host is FreeBSD\)/)
})

test('a login banner, CRLF and blank values do not break the parse', () => {
  const noisy = [
    'Welcome to Ubuntu 24.04.1 LTS',
    '\r',
    'ts=1700000000000\r',
    'uname_s=Linux\r',
    'slow_ok=1\r',
    'temp_0=\r',
    'temp_1=coretemp:48.0\r',
    'gpu_name=\r',
    'listen_count=0\r',
    'not-a-pair\r',
    'slow_done=1\r',
  ].join('\n')
  const parsed = parseSlow(noisy)
  assert.equal(parsed.complete, true)
  assert.deepEqual(parsed.sensors, [{ name: 'coretemp', temperature: 48 }],
    'the empty reading is dropped, the real one survives')
  assert.equal(parsed.tempMax, 48)
  assert.equal(parsed.gpu, null, 'an empty GPU name is not a GPU')
  assert.equal(parsed.listenPorts, 0)
})

test('the script converts millidegrees and filters by mount point', () => {
  assert.ok(SLOW_SCRIPT.includes('v / 1000'), 'thermal zones report millidegrees')
  assert.ok(SLOW_SCRIPT.includes('mnt = $7'), 'df -T puts the mount point seventh')
  assert.ok(SLOW_SCRIPT.includes('mnt = $6'), 'the df -P fallback puts it sixth')
  assert.ok(SLOW_SCRIPT.includes('mnt ~ /^\\/(proc|sys|dev)(\\/|$)/'),
    'pseudo filesystems are excluded by mount point, never by device path')
})
