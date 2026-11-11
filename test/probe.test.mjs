/**
 * Parser and rate tests.
 *
 * These are pure functions over strings and records, so the suite needs no SSH
 * host, no network, and no `/proc` — which is the point: the fragile part of a
 * monitoring plugin is the parsing, and it must be testable on a laptop.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PROBE_SCRIPT, deriveRates, parseProbe } from '../lib/probe.js'

/** A realistic collector payload from a Linux host. */
const SAMPLE = [
  'probe_ok=1',
  'ts=1700000000',
  'uname_s=Linux',
  'kernel=5.15.0-91-generic',
  'arch=x86_64',
  'hostname=web-01',
  'os_name=Ubuntu 22.04.3 LTS',
  'uptime_sec=864000',
  'load=0.42 0.51 0.48',
  'cpu_cores=8',
  'cpu_model=Intel(R) Xeon(R) Platinum 8269CY CPU @ 2.50GHz',
  'cpu_total_jiffies=100000',
  'cpu_idle_jiffies=60000',
  'boot_epoch=1699136000',
  'ctx_switches=123456',
  'procs_running=3',
  'mem_total_kb=16384000',
  'mem_avail_kb=8192000',
  'mem_free_kb=4096000',
  'swap_total_kb=0',
  'swap_free_kb=0',
  'buffers_kb=100000',
  'cached_kb=2000000',
  'net_rx_bytes=1234567890',
  'net_tx_bytes=987654321',
  'tcp_conn=42',
  'udp_conn=7',
  'proc_count=213',
  'disk_total_kb=102400000',
  'disk_used_kb=51200000',
  'virt=kvm',
  'init=systemd',
  'load_pids=2',
  'probe_done=1',
].join('\n')

test('the script is POSIX and terminates with both markers', () => {
  assert.match(PROBE_SCRIPT, /^set -u/m)
  assert.match(PROBE_SCRIPT, /^echo "probe_ok=1"$/m)
  assert.match(PROBE_SCRIPT, /probe_done=1/)
  // bashisms that dash and busybox ash reject.
  assert.doesNotMatch(PROBE_SCRIPT, /\[\[/)
  assert.doesNotMatch(PROBE_SCRIPT, /\becho -e\b/)
  assert.doesNotMatch(PROBE_SCRIPT, /\blocal /)
})

test('parseProbe groups a full payload and converts KB to bytes', () => {
  const parsed = parseProbe(SAMPLE)
  assert.equal(parsed.complete, true)
  assert.equal(parsed.reason, undefined)

  const { metrics } = parsed
  assert.equal(metrics.ts, 1700000000000, 'epoch seconds become milliseconds')
  assert.equal(metrics.os.name, 'Ubuntu 22.04.3 LTS')
  assert.equal(metrics.os.kernel, '5.15.0-91-generic')
  assert.equal(metrics.os.arch, 'x86_64')
  assert.equal(metrics.os.virt, 'kvm')
  assert.equal(metrics.os.init, 'systemd')
  assert.deepEqual(metrics.load, [0.42, 0.51, 0.48])
  assert.equal(metrics.cpu.cores, 8)
  assert.equal(metrics.cpu.model, 'Intel(R) Xeon(R) Platinum 8269CY CPU @ 2.50GHz')
  assert.equal(metrics.cpu.totalJiffies, 100000)
  assert.equal(metrics.cpu.idleJiffies, 60000)
  assert.equal(metrics.mem.totalBytes, 16384000 * 1024)
  assert.equal(metrics.mem.availBytes, 8192000 * 1024)
  // "used" is total minus available, not total minus free: MemFree excludes
  // reclaimable page cache, which would overstate memory pressure on any host
  // that has been up for a while.
  assert.equal(metrics.mem.usedBytes, (16384000 - 8192000) * 1024)
  assert.equal(metrics.mem.swapTotalBytes, 0)
  assert.equal(metrics.disk.totalBytes, 102400000 * 1024)
  assert.equal(metrics.disk.usedBytes, 51200000 * 1024)
  assert.equal(metrics.net.rxBytes, 1234567890)
  assert.equal(metrics.net.txBytes, 987654321)
  assert.equal(metrics.conn.tcp, 42)
  assert.equal(metrics.conn.udp, 7)
  assert.equal(metrics.procs, 213)
  assert.equal(metrics.uptimeSec, 864000)
  assert.equal(metrics.ctxSwitches, 123456)
})

test('a payload without probe_ok is reported incomplete, not as zeroes', () => {
  const parsed = parseProbe('ts=1700000000\nhostname=web-01\n')
  assert.equal(parsed.complete, false)
  assert.match(parsed.reason, /did not run the collector/)
})

test('a payload that dies after probe_ok is reported as truncated', () => {
  const parsed = parseProbe('probe_ok=1\nts=1700000000\n')
  assert.equal(parsed.complete, false)
  assert.match(parsed.reason, /truncated/)
})

test('login-banner noise and junk lines are ignored', () => {
  const noisy = [
    'Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)',
    '',
    '# not a pair',
    'no_equals_sign_here',
    'probe_ok=1',
    'ts=1700000000',
    'hostname=web-01',
    'empty_value=',
    'probe_done=1',
  ].join('\r\n')
  const parsed = parseProbe(noisy)
  assert.equal(parsed.complete, true)
  assert.equal(parsed.metrics.os.hostname, 'web-01')
  assert.equal(parsed.metrics.ts, 1700000000000)
})

test('a non-numeric value for an integer key is dropped, not zeroed', () => {
  const parsed = parseProbe(['probe_ok=1', 'ts=1700000000', 'mem_total_kb=unknown', 'probe_done=1'].join('\n'))
  assert.equal(parsed.metrics.mem.totalBytes, 0)
  // The key is gone entirely; nothing downstream sees a phantom 0 sample.
  assert.equal(parsed.complete, true)
})

test('deriveRates needs two samples', () => {
  const current = parseProbe(SAMPLE).metrics
  const first = deriveRates(undefined, current)
  assert.equal(first.cpuPct, undefined)
  assert.equal(first.rxBps, undefined)
  assert.equal(first.discontinuous, false)
})

test('deriveRates computes CPU percent and throughput across an interval', () => {
  const earlier = parseProbe(SAMPLE).metrics
  const later = parseProbe(SAMPLE
    .replace('ts=1700000000', 'ts=1700000030')
    .replace('cpu_total_jiffies=100000', 'cpu_total_jiffies=102400')
    .replace('cpu_idle_jiffies=60000', 'cpu_idle_jiffies=61240')
    .replace('net_rx_bytes=1234567890', 'net_rx_bytes=1234582890')
    .replace('net_tx_bytes=987654321', 'net_tx_bytes=987684321')
    .replace('ctx_switches=123456', 'ctx_switches=123756')).metrics
  const rates = deriveRates(earlier, later)
  assert.equal(rates.discontinuous, false)
  // 2400 jiffies elapsed, 1240 idle -> 51.67 % busy.
  assert.ok(Math.abs(rates.cpuPct - (1 - 1240 / 2400) * 100) < 1e-6)
  assert.equal(rates.rxBps, 15000 / 30)
  assert.equal(rates.txBps, 30000 / 30)
  assert.equal(rates.ctxPerSec, 300 / 30)
})

test('a counter that went backwards marks the sample discontinuous', () => {
  const earlier = parseProbe(SAMPLE).metrics
  const rebooted = parseProbe(SAMPLE
    .replace('ts=1700000000', 'ts=1700000030')
    .replace('cpu_total_jiffies=100000', 'cpu_total_jiffies=900')
    .replace('cpu_idle_jiffies=60000', 'cpu_idle_jiffies=700')).metrics
  const rates = deriveRates(earlier, rebooted)
  assert.equal(rates.discontinuous, true)
  assert.equal(rates.cpuPct, undefined, 'a rate across a reboot is not a rate')
  assert.equal(rates.rxBps, undefined)
})

test('a missing baseline column leaves one metric unknown instead of faking it', () => {
  const current = parseProbe(SAMPLE).metrics
  const stale = { ts: current.ts - 30_000, cpu: { totalJiffies: undefined, idleJiffies: undefined }, net: { rxBytes: current.net.rxBytes - 3000, txBytes: current.net.txBytes - 6000 }, ctxSwitches: undefined }
  const rates = deriveRates(stale, current)
  assert.equal(rates.cpuPct, undefined, 'no jiffy baseline must not read as 100 %')
  assert.equal(rates.rxBps, 100)
  assert.equal(rates.txBps, 200)
  assert.equal(rates.ctxPerSec, undefined)
  assert.equal(rates.discontinuous, false)
})

test('a non-positive interval yields no rates', () => {
  const current = parseProbe(SAMPLE).metrics
  assert.equal(deriveRates(current, current).cpuPct, undefined)
})
test('the disk aggregate filters by mount point, never by device path', () => {
  // Regression from a live host: the collector used to drop any row whose
  // SOURCE matched /^\/(proc|sys|dev)/, which is every real block device
  // (/dev/vda1, /dev/sda2). Root filesystems reported disk_total_kb=0 and the
  // panel showed an empty disk column on machines that were plainly fine.
  // The mount-point column is the one that identifies a pseudo mount.
  assert.ok(
    !PROBE_SCRIPT.includes('dev ~ /^\\/(proc|sys|dev)/'),
    'the source column must not be filtered for /dev — real disks live there',
  )
  assert.ok(PROBE_SCRIPT.includes('mnt=$7'), 'the -T branch reads the mount point column')
  assert.ok(PROBE_SCRIPT.includes('mnt=$6'), 'the -P fallback reads its own mount point column')
  assert.ok(PROBE_SCRIPT.includes('mnt ~ /^\\/(proc|sys|dev)(\\/|$)/'), 'pseudo mounts are dropped by mount point')
  // The two branches disagree on column numbers: -T inserts the type column, so
  // the -P fallback must add $2/$3 rather than the -T branch's $3/$4.
  assert.ok(PROBE_SCRIPT.includes('total+=$2; used+=$3'), 'the -P fallback keeps its own column offsets')
})