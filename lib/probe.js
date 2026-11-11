/**
 * Remote metric collection over a plain SSH exec channel.
 *
 * The whole point of this module is that it needs **nothing installed on the
 * target**. It ships one POSIX `sh` script, pipes it into the remote shell over
 * an existing SSH connection, and parses `KEY=VALUE` lines back. No agent, no
 * open port, no daemon, no root.
 *
 * The script deliberately reports **monotonic counters** (`cpu_total_jiffies`,
 * `net_rx_bytes`, ...) rather than computed rates. A single sample carries no
 * interval, so the CPU percentage and the network rate can only be derived by
 * comparing two samples — which the store does, against the previous row.
 * Sampling therefore costs one round trip, not two reads separated by a sleep.
 *
 * The script is POSIX sh on purpose: dash, busybox ash, bash and ksh all run it
 * unchanged. It never uses `[[`, arrays, `local`, or `echo -e`.
 *
 * @module dsh-fleet-monitor/probe
 */

/**
 * The collector script. One line of output per metric, `key=value`, no spaces
 * inside a value. Terminates with `probe_ok=1` so a truncated transport is
 * distinguishable from a target that simply has fewer metrics.
 *
 * Everything is defensive: a missing `/proc` entry, a shell without `date`, or
 * a container without `/proc/net/dev` degrades to a missing key instead of
 * failing the whole probe.
 */
export const PROBE_SCRIPT = `set -u
echo "probe_ok=1"
echo "ts=$(date +%s 2>/dev/null || echo 0)"
echo "uname_s=$(uname -s 2>/dev/null || echo unknown)"
echo "kernel=$(uname -r 2>/dev/null || echo unknown)"
echo "arch=$(uname -m 2>/dev/null || echo unknown)"
echo "hostname=$(hostname 2>/dev/null || echo unknown)"
if [ -r /etc/os-release ]; then
  . /etc/os-release 2>/dev/null
  echo "os_name=\${PRETTY_NAME:-unknown}"
fi
if [ -r /proc/uptime ]; then
  echo "uptime_sec=$(cut -d' ' -f1 /proc/uptime 2>/dev/null | cut -d. -f1)"
fi
if [ -r /proc/loadavg ]; then
  echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
fi
if [ -r /proc/stat ]; then
  echo "cpu_cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 0)"
  echo "cpu_model=$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null || echo unknown)"
  awk '/^cpu /{t=0; for(i=2;i<=9;i++) t+=$i; printf "cpu_total_jiffies=%d\\n", t; printf "cpu_idle_jiffies=%d\\n", $5+$6}' /proc/stat
  echo "boot_epoch=$(awk '/^btime /{print $2; exit}' /proc/stat 2>/dev/null || echo 0)"
  echo "ctx_switches=$(awk '/^ctxt /{print $2; exit}' /proc/stat 2>/dev/null || echo 0)"
  echo "procs_running=$(awk '/^procs_running /{print $2; exit}' /proc/stat 2>/dev/null || echo 0)"
fi
if [ -r /proc/meminfo ]; then
  awk '/^MemTotal:/{print "mem_total_kb="$2} /^MemAvailable:/{print "mem_avail_kb="$2} /^MemFree:/{print "mem_free_kb="$2} /^SwapTotal:/{print "swap_total_kb="$2} /^SwapFree:/{print "swap_free_kb="$2} /^Buffers:/{print "buffers_kb="$2} /^Cached:/{print "cached_kb="$2}' /proc/meminfo
fi
if [ -r /proc/net/dev ]; then
  awk 'NR>2{gsub(/^[ \\t]+/,""); gsub(/:/," "); if($1=="lo") next; rx+=$2; tx+=$10} END{printf "net_rx_bytes=%d\\n", rx; printf "net_tx_bytes=%d\\n", tx}' /proc/net/dev
fi
if [ -r /proc/net/tcp ]; then
  echo "tcp_conn=$(($(wc -l < /proc/net/tcp 2>/dev/null || echo 1) - 1))"
fi
if [ -r /proc/net/udp ]; then
  echo "udp_conn=$(($(wc -l < /proc/net/udp 2>/dev/null || echo 1) - 1))"
fi
echo "proc_count=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l | tr -d ' ')"
# df -T exists on GNU coreutils and busybox but not on every BusyBox build, so
# probe for it instead of trusting a pipeline's exit status (awk would mask it).
# Pseudo filesystems are dropped by TYPE. The aggregate is then deduplicated by
# source so bind mounts cannot inflate the total. Note which column is checked
# for /proc, /sys, /dev: the SOURCE of a real disk is itself a device path
# (/dev/vda1), so filtering the source drops every mounted disk and reports a
# zero-byte filesystem; the MOUNT POINT is the column that identifies a
# pseudo mount.
if df -kPT / >/dev/null 2>&1; then
  df -kPT 2>/dev/null | awk 'NR>1{
    dev=$1; fs=$2; mnt=$7;
    if (fs=="tmpfs"||fs=="devtmpfs"||fs=="udev"||fs=="shm"||fs=="none"||fs=="squashfs"||fs=="overlay"||fs=="efivarfs"||fs=="autofs") next;
    if (mnt ~ /^\\/(proc|sys|dev)(\\/|$)/) next;
    if (seen[dev]++) next;
    total+=$3; used+=$4
  } END{if (total>0) printf "disk_total_kb=%d\\ndisk_used_kb=%d\\n", total, used}'
else
  df -kP 2>/dev/null | awk 'NR>1{
    dev=$1; mnt=$6;
    if (dev ~ /^(tmpfs|devtmpfs|udev|shm|none|squashfs|overlay)$/) next;
    if (mnt ~ /^\\/(proc|sys|dev)(\\/|$)/) next;
    if (seen[dev]++) next;
    total+=$2; used+=$3
  } END{if (total>0) printf "disk_total_kb=%d\\ndisk_used_kb=%d\\n", total, used}'
fi
if command -v systemd-detect-virt >/dev/null 2>&1; then
  echo "virt=$(systemd-detect-virt 2>/dev/null || echo unknown)"
fi
if [ -r /proc/1/comm ]; then
  echo "init=$(cat /proc/1/comm 2>/dev/null | tr -d ' ')"
fi
echo "load_pids=$(cut -d' ' -f4 /proc/loadavg 2>/dev/null | cut -d/ -f1)"
echo "probe_done=1"
`

/** Numeric metric keys the parser normalises to integers. */
const INT_KEYS = new Set([
  'ts', 'uptime_sec', 'boot_epoch', 'cpu_cores', 'cpu_total_jiffies', 'cpu_idle_jiffies',
  'mem_total_kb', 'mem_avail_kb', 'mem_free_kb', 'swap_total_kb', 'swap_free_kb',
  'buffers_kb', 'cached_kb', 'net_rx_bytes', 'net_tx_bytes', 'tcp_conn', 'udp_conn',
  'proc_count', 'disk_total_kb', 'disk_used_kb', 'ctx_switches', 'procs_running', 'load_pids',
  // The two framing markers are integers too; leaving them as strings would make
  // the completeness check below compare "1" against 1 and always fail.
  'probe_ok', 'probe_done',
])

/**
 * Parse the collector script's stdout into a metric record.
 *
 * Unknown keys are dropped, `key=value` lines with an empty value are dropped,
 * and a payload without `probe_ok=1` is reported as incomplete — that is the
 * signature of a shell that died before running the script (no shell, a
 * non-interactive login that prints a banner and exits, a forced command).
 * @param stdout - raw remote stdout from {@link PROBE_SCRIPT}.
 * @returns the parsed metrics plus completeness flags.
 */
export function parseProbe(stdout) {
  const raw = {}
  const text = typeof stdout === 'string' ? stdout : ''
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    // A remote login shell can prepend its own banner to the first line; a
    // valid value never contains a space, so a space means we caught noise.
    if (value === '') continue
    if (INT_KEYS.has(key)) {
      const n = Number(value)
      raw[key] = Number.isFinite(n) ? Math.trunc(n) : undefined
      if (raw[key] === undefined) delete raw[key]
    } else {
      raw[key] = value
    }
  }
  const complete = raw.probe_ok === 1 && raw.probe_done === 1
  return {
    metrics: normalise(raw),
    complete,
    /** @returns why the payload is incomplete, for the UI. */
    reason: complete ? undefined : raw.probe_ok !== 1
      ? 'remote shell did not run the collector (forced command, non-POSIX shell, or a login banner that closed the channel)'
      : 'collector exited before finishing (truncated output)',
  }
}

/**
 * Fold the flat key set into the grouped shape the API and the panel use, so
 * the browser never has to know about `/proc` units.
 * @param raw - parsed `KEY=VALUE` map.
 * @returns grouped metrics (memory and disk in bytes, rates left for the store).
 */
function normalise(raw) {
  const kb = 1024
  const memTotal = raw.mem_total_kb ?? 0
  // MemAvailable is the honest "free" figure on any kernel >= 3.14; the
  // fallback is free+buffers+cached, which is what top shows on older kernels.
  const memAvail = raw.mem_avail_kb ?? ((raw.mem_free_kb ?? 0) + (raw.buffers_kb ?? 0) + (raw.cached_kb ?? 0))
  const swapTotal = raw.swap_total_kb ?? 0
  const swapFree = raw.swap_free_kb ?? 0
  return {
    ts: (raw.ts ?? 0) * 1000 || Date.now(),
    os: {
      name: raw.os_name ?? 'unknown',
      kernel: raw.kernel ?? 'unknown',
      arch: raw.arch ?? 'unknown',
      hostname: raw.hostname ?? 'unknown',
      virt: raw.virt ?? undefined,
      init: raw.init ?? undefined,
    },
    uptimeSec: raw.uptime_sec ?? 0,
    bootEpoch: raw.boot_epoch ?? 0,
    load: parseLoad(raw.load),
    cpu: {
      cores: raw.cpu_cores ?? 0,
      model: raw.cpu_model ?? 'unknown',
      totalJiffies: raw.cpu_total_jiffies ?? 0,
      idleJiffies: raw.cpu_idle_jiffies ?? 0,
    },
    mem: {
      totalBytes: memTotal * kb,
      usedBytes: Math.max(0, memTotal - memAvail) * kb,
      availBytes: memAvail * kb,
      swapTotalBytes: swapTotal * kb,
      swapUsedBytes: Math.max(0, swapTotal - swapFree) * kb,
    },
    disk: {
      totalBytes: (raw.disk_total_kb ?? 0) * kb,
      usedBytes: (raw.disk_used_kb ?? 0) * kb,
    },
    net: {
      rxBytes: raw.net_rx_bytes ?? 0,
      txBytes: raw.net_tx_bytes ?? 0,
    },
    conn: {
      tcp: raw.tcp_conn ?? 0,
      udp: raw.udp_conn ?? 0,
    },
    procs: raw.proc_count ?? 0,
    ctxSwitches: raw.ctx_switches ?? 0,
  }
}

/**
 * Parse the three load averages.
 * @param value - `load` value from the probe (`0.12 0.08 0.05`).
 * @returns the three averages, zero-filled.
 */
function parseLoad(value) {
  const parts = typeof value === 'string' ? value.trim().split(/\s+/) : []
  return [0, 1, 2].map(i => {
    const n = Number(parts[i])
    return Number.isFinite(n) ? n : 0
  })
}

/**
 * Derive rates that need two samples: CPU utilisation, network throughput, and
 * context-switch rate. The store keeps the previous row per node, so this is a
 * pure function of two records.
 *
 * A counter that went **backwards** means the target rebooted (or the counter
 * wrapped): every delta is then reported as `undefined` instead of a negative
 * or absurd rate, and the caller marks the node's history as discontinuous.
 * @param previous - the earlier normalised record, or undefined on the first sample.
 * @param current - the record just collected.
 * @returns derived rates; fields are undefined when they cannot be computed.
 */
export function deriveRates(previous, current) {
  if (previous === undefined || previous === null) {
    return { cpuPct: undefined, rxBps: undefined, txBps: undefined, ctxPerSec: undefined, discontinuous: false }
  }
  const dtSec = (current.ts - previous.ts) / 1000
  if (!(dtSec > 0)) {
    return { cpuPct: undefined, rxBps: undefined, txBps: undefined, ctxPerSec: undefined, discontinuous: false }
  }
  // Each counter is differenced independently: a row written before a column
  // existed (or a degraded store) leaves one metric unknown without discarding
  // the others, and a null counter must never be read as zero — that would turn
  // a missing baseline into a 100 % CPU spike.
  const delta = (before, after) =>
    Number.isFinite(before) && Number.isFinite(after) ? after - before : undefined
  const dTotal = delta(previous.cpu?.totalJiffies, current.cpu.totalJiffies)
  const dIdle = delta(previous.cpu?.idleJiffies, current.cpu.idleJiffies)
  const dRx = delta(previous.net?.rxBytes, current.net.rxBytes)
  const dTx = delta(previous.net?.txBytes, current.net.txBytes)
  const dCtx = delta(previous.ctxSwitches, current.ctxSwitches)
  const regressed = [dTotal, dIdle, dRx, dTx].some((value) => value !== undefined && value < 0)
  if (regressed) {
    // The target rebooted or a counter wrapped: a rate across the discontinuity
    // is meaningless, so the sample records the counters but no derived value.
    return { cpuPct: undefined, rxBps: undefined, txBps: undefined, ctxPerSec: undefined, discontinuous: true }
  }
  const cpuPct = dTotal !== undefined && dTotal > 0 && dIdle !== undefined
    ? Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100))
    : undefined
  return {
    cpuPct,
    rxBps: dRx === undefined ? undefined : dRx / dtSec,
    txBps: dTx === undefined ? undefined : dTx / dtSec,
    ctxPerSec: dCtx === undefined || dCtx < 0 ? undefined : dCtx / dtSec,
    discontinuous: false,
  }
}
