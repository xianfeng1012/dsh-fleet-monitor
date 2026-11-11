/**
 * The slow probe: hardware the fast sweep deliberately does not touch.
 *
 * The 30-second sweep has to stay cheap — one `/proc` read per host. Everything
 * that shells out or walks `/sys` (temperatures, GPU, listening sockets, every
 * partition) runs on its own five-minute cadence and lands in `host_hardware`,
 * where the fast sample reads it back. Reading `/sys/class/thermal` 30 times as
 * often as the value changes would cost real CPU on small instances, and
 * `nvidia-smi` alone can take 200 ms.
 *
 * The script is POSIX `sh` on purpose: the targets are whatever the operator
 * already has, and `bash` is not guaranteed. Every optional block degrades to
 * "not present" rather than failing the probe, because a host with no sensors is
 * a normal host, not an error.
 *
 * @module dsh-fleet-monitor/probe-slow
 */

/**
 * One POSIX shell script that emits `KEY=VALUE` lines.
 *
 * Indexed keys (`temp_0`, `part_3`, `nic_1`) carry lists; everything else is a
 * scalar. `slow_ok=1` opens the payload and `slow_done=1` closes it, so a
 * truncated stream is detectable instead of being read as "no sensors".
 */
export const SLOW_SCRIPT = `set -u
ts=$(date +%s%3N 2>/dev/null || echo $(($(date +%s) * 1000)))
uname_s=$(uname -s 2>/dev/null || echo unknown)
printf 'ts=%s\\n' "$ts"
printf 'uname_s=%s\\n' "$uname_s"

if [ "$uname_s" = "Linux" ]; then
  printf 'slow_ok=1\\n'

  # --- temperatures ---------------------------------------------------------
  i=0
  for f in /sys/class/thermal/thermal_zone*/temp; do
    [ -r "$f" ] || continue
    v=$(cat "$f" 2>/dev/null) || continue
    case "$v" in ''|*[!0-9-]*) continue ;; esac
    name=$(cat "\${f%/*}/type" 2>/dev/null) || name=thermal
    printf 'temp_%s=' "$i"
    awk -v n="$name" -v v="$v" 'BEGIN { if (v >= 1000) v = v / 1000; printf "%s:%.1f\\n", n, v }'
    i=$((i + 1))
    [ "$i" -ge 24 ] && break
  done
  for f in /sys/class/hwmon/hwmon*/temp*_input; do
    [ -r "$f" ] || continue
    v=$(cat "$f" 2>/dev/null) || continue
    case "$v" in ''|*[!0-9-]*) continue ;; esac
    dir=\${f%/*}
    name=$(cat "$dir/name" 2>/dev/null) || name=hwmon
    printf 'temp_%s=' "$i"
    awk -v n="$name" -v v="$v" 'BEGIN { if (v >= 1000) v = v / 1000; printf "%s:%.1f\\n", n, v }'
    i=$((i + 1))
    [ "$i" -ge 40 ] && break
  done

  # --- GPU ------------------------------------------------------------------
  if command -v nvidia-smi >/dev/null 2>&1; then
    line=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits 2>/dev/null | head -n 1)
    if [ -n "$line" ]; then
      util=$(printf '%s' "$line" | cut -d, -f1 | tr -d ' ')
      mused=$(printf '%s' "$line" | cut -d, -f2 | tr -d ' ')
      mtotal=$(printf '%s' "$line" | cut -d, -f3 | tr -d ' ')
      gname=$(printf '%s' "$line" | cut -d, -f4- | sed 's/^ *//')
      printf 'gpu_util=%s\\n' "$util"
      printf 'gpu_mem_used=%s\\n' "$mused"
      printf 'gpu_mem_total=%s\\n' "$mtotal"
      printf 'gpu_name=%s\\n' "$gname"
    fi
  fi

  # --- listening sockets ----------------------------------------------------
  ports=''
  if command -v ss >/dev/null 2>&1; then
    ports=$(ss -lntu 2>/dev/null | tail -n +2 | awk '{print $5}' | sed 's/.*://' | grep -E '^[0-9]+$' | sort -n -u | head -n 64)
  elif command -v netstat >/dev/null 2>&1; then
    ports=$(netstat -lntu 2>/dev/null | awk 'NR > 2 {print $4}' | sed 's/.*://' | grep -E '^[0-9]+$' | sort -n -u | head -n 64)
  fi
  if [ -n "$ports" ]; then
    count=$(printf '%s\\n' "$ports" | wc -l | tr -d ' ')
    printf 'listen_count=%s\\n' "$count"
    i=0
    for p in $ports; do
      printf 'listen_%s=%s\\n' "$i" "$p"
      i=$((i + 1))
    done
  else
    printf 'listen_count=0\\n'
  fi

  # --- every real partition -------------------------------------------------
  if df -kPT / >/dev/null 2>&1; then
    df -kPT 2>/dev/null | awk '
      NR == 1 { next }
      {
        mnt = $7
        if (mnt ~ /^\\/(proc|sys|dev)(\\/|$)/) next
        if ($2 == "tmpfs" || $2 == "devtmpfs" || $2 == "udev" || $2 == "squashfs" || $2 == "overlay" || $2 == "efivarfs" || $2 == "autofs" || $2 == "devfs" || $2 == "none") next
        if (seen[mnt]++) next
        printf "part_%d=%s|%d|%d\\n", n, mnt, $4 * 1024, $3 * 1024
        n++
      }'
  else
    df -kP 2>/dev/null | awk '
      NR == 1 { next }
      {
        mnt = $6
        if (mnt ~ /^\\/(proc|sys|dev)(\\/|$)/) next
        if ($1 == "tmpfs" || $1 == "devtmpfs" || $1 == "udev" || $1 == "none") next
        if (seen[mnt]++) next
        printf "part_%d=%s|%d|%d\\n", n, mnt, $3 * 1024, $2 * 1024
        n++
      }'
  fi

  # --- every interface except loopback --------------------------------------
  awk -F: '
    NR > 2 {
      iface = $1
      gsub(/ /, "", iface)
      if (iface == "lo" || iface == "") next
      split($2, f, " ")
      rx = f[1]
      tx = f[9]
      if (rx == "" || tx == "") next
      printf "nic_%d=%s|%s|%s\\n", n, iface, rx, tx
      n++
    }' /proc/net/dev 2>/dev/null
fi

printf 'slow_done=1\\n'
`

/**
 * Parse the slow probe's stdout.
 *
 * Tolerates a login banner, CRLF, blank values and stray lines: the same script
 * runs through `sh -c` on hosts whose shell profile prints a MOTD first.
 *
 * @param stdout - the raw command output.
 * @returns the normalised hardware snapshot.
 */
export function parseSlow(stdout) {
  const raw = Object.create(null)
  const lists = { temp: [], part: [], nic: [] }

  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed.length === 0) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at)
    const value = trimmed.slice(at + 1)
    const indexed = /^(temp|part|nic)_(\d+)$/.exec(key)
    if (indexed !== null) {
      lists[indexed[1]].push({ index: Number(indexed[2]), value })
      continue
    }
    if (/^[a-z][a-z0-9_]*$/.test(key)) raw[key] = value
  }

  // `slow_ok` marks "the Linux branch ran" and `slow_done` marks "the script
  // reached the end". Both are required: a FreeBSD host reaches the end without
  // ever entering the branch, and reporting that as a complete payload of zero
  // sensors would look exactly like a healthy machine with no thermal zone.
  if (raw.slow_ok !== '1' || raw.slow_done !== '1') {
    const reason = raw.uname_s !== undefined && raw.uname_s !== 'Linux'
      ? `hardware probe supports Linux only (host is ${raw.uname_s})`
      : raw.slow_done !== '1'
        ? 'the host did not run the hardware probe to completion'
        : 'the host ran the probe but reported no hardware data'
    return {
      complete: false,
      reason,
      ts: epochMillis(raw.ts),
      tempMax: null, sensors: [], gpu: null,
      listenPorts: null, listenList: [], partitions: [], nics: [],
    }
  }

  const sensors = lists.temp
    .sort(byIndex)
    .map(entry => {
      const at = entry.value.indexOf(':')
      if (at <= 0) return null
      const temperature = Number(entry.value.slice(at + 1))
      return Number.isFinite(temperature)
        ? { name: entry.value.slice(0, at), temperature }
        : null
    })
    .filter(entry => entry !== null)

  const tempMax = sensors.length === 0
    ? null
    : sensors.reduce((max, sensor) => Math.max(max, sensor.temperature), -Infinity)

  const partitions = lists.part.sort(byIndex).map(entry => {
    const [mount, used, total] = entry.value.split('|')
    return {
      mount: mount ?? '',
      used: int(used) ?? null,
      total: int(total) ?? null,
    }
  }).filter(entry => entry.mount !== '')

  const nics = lists.nic.sort(byIndex).map(entry => {
    const [name, rxBytes, txBytes] = entry.value.split('|')
    return {
      name: name ?? '',
      rxBytes: int(rxBytes) ?? null,
      txBytes: int(txBytes) ?? null,
    }
  }).filter(entry => entry.name !== '')

  const listenList = []
  for (const [key, value] of Object.entries(raw)) {
    const match = /^listen_(\d+)$/.exec(key)
    if (match !== null) listenList.push({ index: Number(match[1]), value })
  }
  const ports = listenList
    .sort(byIndex)
    .map(entry => int(entry.value))
    .filter(port => port !== undefined)

  const gpuUtil = num(raw.gpu_util)
  const gpuMemTotal = int(raw.gpu_mem_total)
  const gpu = gpuUtil === undefined && gpuMemTotal === undefined ? null : {
    util: gpuUtil ?? null,
    memUsed: int(raw.gpu_mem_used) ?? null,
    memTotal: gpuMemTotal ?? null,
    name: raw.gpu_name ?? null,
  }

  return {
    complete: true,
    reason: '',
    ts: epochMillis(raw.ts),
    tempMax,
    sensors,
    gpu,
    listenPorts: int(raw.listen_count) ?? ports.length,
    listenList: ports,
    partitions,
    nics,
  }
}

/** Sort indexed list entries numerically. */
function byIndex(a, b) {
  return a.index - b.index
}

/** Parse a finite integer, or undefined. */
function int(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined
}

/**
 * Parse the remote clock into milliseconds, whatever unit it printed in.
 *
 * The script asks for `date +%s%3N`, which is a GNU extension. busybox reads the
 * width suffix as part of `%N` and answers with epoch seconds followed by nine
 * nanoseconds — a nineteen digit number. That value is above
 * Number.MAX_SAFE_INTEGER, and node:sqlite refuses to read such a column back, so
 * one host with the wrong date binary used to blank the entire panel. Scaling by
 * magnitude costs nothing and makes the unit question go away.
 *
 * @param value - raw `ts` line from the probe.
 */
export function epochMillis(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now()
  if (parsed > 1e14) return Math.round(parsed / 1e6)
  if (parsed > 1e11) return Math.round(parsed)
  return Math.round(parsed * 1000)
}

/** Parse a finite number, or undefined. */
function num(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
