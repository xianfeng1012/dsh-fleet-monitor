/**
 * Metric history, with a graceful floor under it.
 *
 * The primary store is `node:sqlite` (Node 24 ships it, no native build, which
 * is exactly what a plugin market's dependency scanner wants to see). If the
 * runtime refuses it — an older Node, a build without SQLite, a read-only home
 * — the same interface is served from memory with a JSON snapshot beside it, so
 * the panel still shows live numbers instead of an error page. History depth is
 * shorter in that mode and the API says so.
 *
 * @module dsh-fleet-monitor/store
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { applySchema } from './store-schema.js'

/**
 * Synchronous resolver for the optional `node:sqlite` builtin.
 *
 * The plugin's `apply` must stay synchronous: the host calls it inside its own
 * fiber setup, and a promise returned from there is not awaited, so a rejected
 * `await import()` would surface as an unhandled rejection instead of the
 * documented JSON fallback. `require` of a builtin cannot fail asynchronously.
 */
const requireBuiltin = createRequire(import.meta.url)

/** Default retained samples per node (2880 × 30 s ≈ 24 h). */
export const DEFAULT_KEEP = 2880

/** Samples retained per node when falling back to the JSON store. */
const FALLBACK_KEEP = 240

/**
 * 5-minute rollups retained per node in the JSON store.
 *
 * The JSON backend is a fallback, not the analytics store, so this is bounded
 * well below the SQLite 30-day window: 2880 buckets is 10 days, which keeps the
 * in-memory snapshot small enough to rewrite every 30 seconds.
 */
const JSON_KEEP_5M = 2880

/**
 * Measurements retained per service probe.
 *
 * 200 is two orders of magnitude more than the 30-cell grid the panel draws, so
 * a probe that runs every minute keeps three hours of evidence for "when did it
 * actually break" without the table growing without bound.
 */
export const PROBE_KEEP = 200

/** Cells in the fixed grid the panel renders (matches Nezha's `Delay *[30]`). */
export const PROBE_GRID = 30

/**
 * Executions retained per scheduled task.
 *
 * A task that runs every five minutes fills this in under two days, which is the
 * window an operator actually scrolls through after something breaks. Older runs
 * are dropped by the same statement that inserts the new one.
 */
export const CRON_RUN_KEEP = 500

/**
 * Decode one `managed_host` row into the camelCase shape the routes speak.
 *
 * The panel is the only writer, but the database is a plain file an operator can
 * edit, so broken `tags` JSON costs that host its tags rather than throwing the
 * whole host list away.
 *
 * @param row - a raw `managed_host` row.
 * @returns the host record handed to `discoverHosts`.
 */
function decodeManagedRow(row) {
  let tags = []
  try {
    const parsed = JSON.parse(row.tags ?? '[]')
    if (Array.isArray(parsed)) tags = parsed.filter(item => typeof item === 'string')
  } catch {
    tags = []
  }
  return {
    alias: row.alias,
    host: row.host,
    port: row.port,
    user: row.user,
    authKind: row.auth_kind,
    keyPath: row.key_path ?? null,
    passphrase: row.passphrase ?? null,
    password: row.password ?? null,
    tags,
    note: row.note ?? null,
    groupName: row.group_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Bring a stored timestamp back to milliseconds.
 *
 * A remote `date +%s%3N` is not portable: busybox reads the width suffix as part
 * of `%N` and prints epoch seconds followed by nine nanoseconds, which arrives as
 * a nineteen digit number. Anything that large is nanoseconds; anything past the
 * millisecond range but below it is seconds. Returning milliseconds either way
 * keeps one bad clock from poisoning a whole table.
 *
 * @param value - stored number, possibly in seconds, milliseconds, or nanoseconds.
 */
function toMillis(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  if (numeric > 1e14) return Math.round(numeric / 1e6)
  if (numeric > 1e11) return Math.round(numeric)
  return Math.round(numeric * 1000)
}

/**
 * Parse a JSON column, falling back to the caller's default.
 *
 * The database is a plain file: an operator with a text editor can break a JSON
 * column. That must cost the affected field, never the row.
 *
 * @param value - raw column text.
 * @param fallback - value returned when the text is absent or unparseable.
 * @param guard - optional shape check; a failing check also returns the fallback.
 */
function parseJsonColumn(value, fallback, guard) {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    const parsed = JSON.parse(value)
    return guard === undefined || guard(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/** @param row - a raw `host_meta` row. @returns the camelCase metadata record. */
function decodeMetaRow(row) {
  return {
    alias: row.alias,
    displayName: row.display_name ?? null,
    groupName: row.group_name ?? null,
    tags: parseJsonColumn(row.tags, [], Array.isArray),
    note: row.note ?? null,
    displayIndex: row.display_index ?? 0,
    hidden: row.hidden === 1,
    expireAt: row.expire_at ?? null,
    price: row.price ?? null,
    bandwidthGb: row.bandwidth_gb ?? null,
    updatedAt: row.updated_at,
  }
}

/**
 * Decode one `cron_task` row.
 *
 * `cover` is a JSON scope, decoded the same way alert rules are: a row that a
 * human edited into an invalid state falls back to "all hosts" rather than
 * throwing while the panel is rendering.
 */
function decodeCronTaskRow(row) {
  const cover = parseJsonColumn(row.cover, { mode: 'all', aliases: [] },
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value))
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    command: row.command,
    cover: { mode: cover.mode ?? 'all', aliases: Array.isArray(cover.aliases) ? cover.aliases : [] },
    timeoutMs: row.timeout_ms ?? 60_000,
    notifyGroupId: row.notify_group_id ?? null,
    enabled: row.enabled === 1 || row.enabled === true,
    lastRunAt: row.last_run_at ?? null,
    lastOk: row.last_ok === null || row.last_ok === undefined ? null : row.last_ok === 1,
    createdAt: row.created_at ?? null,
  }
}

/** @param row - a raw `cron_run` row. @returns the run in API shape. */
function decodeCronRunRow(row) {
  const total = row.total ?? 0
  const okCount = row.ok_count ?? 0
  return {
    id: row.id,
    taskId: row.task_id,
    ts: row.ts,
    total,
    okCount,
    // Derived, not stored: the run is only "ok" when every covered host
    // succeeded. A partial failure is a failure — the panel colours the pill
    // from this field and there is no separate count to read.
    ok: total > 0 && okCount === total,
    durationMs: row.duration_ms ?? 0,
    output: row.output ?? '',
  }
}

/** @param row - a raw `host_hardware` row. @returns the snapshot in API shape. */
function decodeHardwareRow(row) {
  return {
    alias: row.alias,
    ts: toMillis(row.ts),
    tempMax: row.temp_max ?? null,
    sensors: parseJsonColumn(row.sensors, [], Array.isArray),
    gpu: row.gpu_util === null && row.gpu_mem_total === null ? null : {
      util: row.gpu_util ?? null,
      memUsed: row.gpu_mem_used ?? null,
      memTotal: row.gpu_mem_total ?? null,
      name: row.gpu_name ?? null,
    },
    listenPorts: row.listen_ports ?? null,
    listenList: parseJsonColumn(row.listen_list, [], Array.isArray),
    partitions: parseJsonColumn(row.partitions, [], Array.isArray),
    nics: parseJsonColumn(row.nics, [], Array.isArray),
    error: row.error ?? null,
  }
}

/**
 * Decode one `service_probe` row into the camelCase shape the routes speak.
 *
 * `enabled` travels as a boolean because every caller treats it as one; the
 * column is an integer only because SQLite has no boolean type.
 *
 * @param row - a raw `service_probe` row.
 * @returns the probe definition.
 */
function decodeProbeRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    type: Number(row.type),
    target: row.target,
    intervalSec: row.interval_sec ?? 60,
    timeoutMs: row.timeout_ms ?? 5000,
    expectStatus: row.expect_status ?? null,
    expectKeyword: row.expect_keyword ?? null,
    maxLatencyMs: row.max_latency_ms ?? 0,
    notifyGroupId: row.notify_group_id ?? null,
    enabled: row.enabled !== 0,
    createdAt: row.created_at ?? null,
  }
}

/**
 * Decode one `probe_result` row.
 *
 * `ok` becomes a boolean for the same reason `enabled` does; `latencyMs`,
 * `statusCode` and `certDays` stay nullable because a TCP timeout has no
 * latency and an ICMP reply has no status code — reporting them as 0 would make
 * "never answered" look like "answered instantly".
 *
 * @param row - a raw `probe_result` row.
 * @returns the measurement in API shape.
 */
function decodeProbeResult(row) {
  return {
    ts: row.ts,
    ok: row.ok === 1 || row.ok === true,
    latencyMs: row.latency_ms ?? null,
    statusCode: row.status_code ?? null,
    error: row.error ?? null,
    certDays: row.cert_days ?? null,
  }
}

/**
 * Convert one `alert_rule` row to API shape.
 *
 * `scope` is a JSON string in the table because it is a variable-length list of
 * aliases; a malformed value falls back to "every host" so a hand-edited row
 * still produces a rule instead of an exception on every evaluation.
 *
 * @param row - a raw `alert_rule` row.
 * @returns the rule in API shape.
 */
function decodeAlertRuleRow(row) {
  const scope = parseJsonColumn(row.scope, { mode: 'all', aliases: [] }, (value) => value !== null && typeof value === 'object')
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    op: row.op ?? 'gt',
    threshold: row.threshold,
    durationSec: row.duration_sec ?? 180,
    scope,
    notifyGroupId: row.notify_group_id ?? null,
    cooldownSec: row.cooldown_sec ?? 1800,
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: row.created_at,
  }
}

/**
 * Convert one `alert_event` row to API shape.
 *
 * @param row - a raw `alert_event` row.
 * @returns the event in API shape.
 */
function decodeAlertEventRow(row) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    alias: row.alias,
    state: row.state,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    peak: row.peak ?? null,
    lastValue: row.last_value ?? null,
    message: row.message ?? null,
  }
}

/**
 * Convert one `notify_channel` row to API shape.
 *
 * @param row - a raw `notify_channel` row.
 * @returns the channel in API shape.
 */
function decodeChannelRow(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method ?? 'POST',
    bodyType: row.body_type ?? 'json',
    headers: row.headers ?? '{}',
    body: row.body ?? '',
    verifyTls: row.verify_tls !== 0,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
  }
}

/**
 * Open the history store next to the host's own state, preferring SQLite.
 * @param options - store inputs.
 * @param options.dshHome - directory holding the database and fallback JSON.
 * @param options.keep - retained samples per node.
 * @returns a store exposing the same shape in both modes; `backend` names the
 *   one in use so the API can report reduced history honestly.
 */
export function openStore(options = {}) {
  const dshHome = options.dshHome ?? join(process.cwd(), '.dsh')
  const keep = Math.max(10, options.keep ?? DEFAULT_KEEP)
  const dbPath = join(dshHome, 'dsh-fleet-monitor.sqlite')
  try {
    mkdirSync(dshHome, { recursive: true })
    const { DatabaseSync } = requireBuiltin('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      const store = new SqliteStore(db, keep)
      store.path = dbPath
      return store
    } catch (error) {
      // A schema or statement failure must release the handle before falling
      // back: an open DatabaseSync keeps the file locked on Windows, so the next
      // open in the same process would fail for a reason nobody can see.
      try { db.close() } catch { /* already closed or never opened */ }
      throw error
    }
  } catch (error) {
    const jsonPath = join(dshHome, 'dsh-fleet-monitor.fallback.json')
    const store = new JsonStore(jsonPath, Math.min(keep, FALLBACK_KEEP))
    store.reason = error instanceof Error ? error.message : String(error)
    return store
  }
}

/**
 * SQLite-backed history.
 *
 * `sample` is append-only and keyed by `(alias, ts)`: two polls landing in the
 * same millisecond collapse to one row instead of corrupting a rate, which
 * matters because the network throughput is a delta against the previous row.
 */
class SqliteStore {
  /** @param db - an open `DatabaseSync`. @param keep - retained samples per node. */
  constructor(db, keep) {
    this.backend = 'sqlite'
    this.keep = keep
    this.db = db
    // Every table and every column migration lives in store-schema.js; the
    // return value names the columns appended to a pre-existing sample table.
    this.migratedColumns = applySchema(this.db)
    this.stmtUpsertNode = this.db.prepare(`
      INSERT INTO node (alias, host, port, user, source, status, last_ok, last_error, latency_ms,
                        os_name, kernel, arch, cores, cpu_model, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        host = excluded.host, port = excluded.port, user = excluded.user,
        source = excluded.source, status = excluded.status, last_ok = excluded.last_ok,
        last_error = excluded.last_error, latency_ms = excluded.latency_ms,
        os_name = excluded.os_name, kernel = excluded.kernel, arch = excluded.arch,
        cores = excluded.cores, cpu_model = excluded.cpu_model, updated_at = excluded.updated_at
    `)
    this.stmtInsertSample = this.db.prepare(`
      INSERT OR REPLACE INTO sample
        (alias, ts, cpu_pct, load1, load5, load15, mem_used, mem_total, swap_used, swap_total,
         disk_used, disk_total, rx_bps, tx_bps, rx_bytes, tx_bytes, tcp, udp, procs, uptime_sec,
         cpu_total, cpu_idle, ctx_switches,
         temp_max, gpu_util, gpu_mem_used, gpu_mem_total, listen_ports)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtPrevious = this.db.prepare('SELECT * FROM sample WHERE alias = ? ORDER BY ts DESC LIMIT 1')
    this.stmtLatest = this.db.prepare(`
      SELECT n.*, s.ts AS sample_ts, s.cpu_pct, s.load1, s.load5, s.load15,
             s.mem_used, s.mem_total, s.swap_used, s.swap_total, s.disk_used, s.disk_total,
             s.rx_bps, s.tx_bps, s.rx_bytes, s.tx_bytes, s.tcp, s.udp, s.procs, s.uptime_sec
      FROM node n
      LEFT JOIN sample s ON s.alias = n.alias
        AND s.ts = (SELECT MAX(ts) FROM sample WHERE alias = n.alias)
      ORDER BY n.alias
    `)
    this.stmtHistory = this.db.prepare('SELECT * FROM sample WHERE alias = ? AND ts >= ? ORDER BY ts DESC LIMIT ?')
    this.stmtPrune = this.db.prepare(`
      DELETE FROM sample WHERE alias = ? AND ts NOT IN (
        SELECT ts FROM sample WHERE alias = ? ORDER BY ts DESC LIMIT ?
      )
    `)
    this.stmtDeleteNode = this.db.prepare('DELETE FROM node WHERE alias = ?')
    this.stmtDeleteSamples = this.db.prepare('DELETE FROM sample WHERE alias = ?')
    this.stmtListManaged = this.db.prepare('SELECT * FROM managed_host ORDER BY alias')
    this.stmtUpsertManaged = this.db.prepare(`
      INSERT INTO managed_host (alias, host, port, user, auth_kind, key_path, passphrase, password,
                                tags, note, group_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        host = excluded.host, port = excluded.port, user = excluded.user,
        auth_kind = excluded.auth_kind, key_path = excluded.key_path,
        passphrase = excluded.passphrase, password = excluded.password,
        tags = excluded.tags, note = excluded.note, group_name = excluded.group_name,
        updated_at = excluded.updated_at
    `)
    this.stmtDeleteManaged = this.db.prepare('DELETE FROM managed_host WHERE alias = ?')

    // 5-minute rollup. Overwritten in place per bucket (see upsertSample5m).
    this.stmtUpsertSample5m = this.db.prepare(`
      INSERT INTO sample_5m (alias, ts, cpu_pct, mem_used, mem_total, disk_used, disk_total,
                             rx_bps, tx_bps, load1, tcp, procs, temp_max, gpu_util)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias, ts) DO UPDATE SET
        cpu_pct = excluded.cpu_pct, mem_used = excluded.mem_used, mem_total = excluded.mem_total,
        disk_used = excluded.disk_used, disk_total = excluded.disk_total,
        rx_bps = excluded.rx_bps, tx_bps = excluded.tx_bps, load1 = excluded.load1,
        tcp = excluded.tcp, procs = excluded.procs,
        temp_max = excluded.temp_max, gpu_util = excluded.gpu_util
    `)
    this.stmtSample5m = this.db.prepare(
      'SELECT * FROM sample_5m WHERE alias = ? AND ts >= ? ORDER BY ts DESC LIMIT ?')
    this.stmtBucketSamples = this.db.prepare(
      'SELECT * FROM sample WHERE alias = ? AND ts >= ? ORDER BY ts ASC')
    this.stmtPruneSample5m = this.db.prepare('DELETE FROM sample_5m WHERE ts < ?')

    this.stmtBumpDaily = this.db.prepare(`
      INSERT INTO daily_stat (alias, day, samples, up_samples, rx_bytes, tx_bytes)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(alias, day) DO UPDATE SET
        samples = samples + 1,
        up_samples = up_samples + excluded.up_samples,
        rx_bytes = rx_bytes + excluded.rx_bytes,
        tx_bytes = tx_bytes + excluded.tx_bytes
    `)
    this.stmtDailyStats = this.db.prepare(
      'SELECT * FROM daily_stat WHERE day >= ? ORDER BY day ASC, alias ASC')
    this.stmtPruneDaily = this.db.prepare('DELETE FROM daily_stat WHERE day < ?')

    this.stmtListMeta = this.db.prepare('SELECT * FROM host_meta ORDER BY display_index, alias')
    this.stmtUpsertMeta = this.db.prepare(`
      INSERT INTO host_meta (alias, display_name, group_name, tags, note, display_index, hidden,
                             expire_at, price, bandwidth_gb, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        display_name = excluded.display_name, group_name = excluded.group_name,
        tags = excluded.tags, note = excluded.note, display_index = excluded.display_index,
        hidden = excluded.hidden, expire_at = excluded.expire_at, price = excluded.price,
        bandwidth_gb = excluded.bandwidth_gb, updated_at = excluded.updated_at
    `)
    this.stmtDeleteMeta = this.db.prepare('DELETE FROM host_meta WHERE alias = ?')

    // `ts` is cast to REAL on the way out on purpose. A host whose `date` treats
    // `%3N` as `%N` writes an epoch in nanoseconds, which is above
    // Number.MAX_SAFE_INTEGER — node:sqlite refuses to convert it and throws, and
    // that throw used to take down the whole sweep from inside hardwareFor. The
    // cast keeps the value readable (as a float) so decodeHardwareRow can scale it
    // back into milliseconds instead of the panel going blank.
    this.stmtListHardware = this.db.prepare(
      `SELECT alias, CAST(ts AS REAL) AS ts, temp_max, sensors, gpu_util, gpu_mem_used,
              gpu_mem_total, gpu_name, listen_ports, listen_list, partitions, nics, error
         FROM host_hardware ORDER BY alias`,
    )
    this.stmtHardwareFor = this.db.prepare(
      `SELECT alias, CAST(ts AS REAL) AS ts, temp_max, sensors, gpu_util, gpu_mem_used,
              gpu_mem_total, gpu_name, listen_ports, listen_list, partitions, nics, error
         FROM host_hardware WHERE alias = ?`,
    )
    this.stmtUpsertHardware = this.db.prepare(`
      INSERT INTO host_hardware (alias, ts, temp_max, sensors, gpu_util, gpu_mem_used,
                                 gpu_mem_total, gpu_name, listen_ports, listen_list,
                                 partitions, nics, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        ts = excluded.ts, temp_max = excluded.temp_max, sensors = excluded.sensors,
        gpu_util = excluded.gpu_util, gpu_mem_used = excluded.gpu_mem_used,
        gpu_mem_total = excluded.gpu_mem_total, gpu_name = excluded.gpu_name,
        listen_ports = excluded.listen_ports, listen_list = excluded.listen_list,
        partitions = excluded.partitions, nics = excluded.nics, error = excluded.error
    `)

    this.stmtListSettings = this.db.prepare('SELECT key, value FROM setting')
    this.stmtUpsertSetting = this.db.prepare(`
      INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    this.stmtClearSettings = this.db.prepare('DELETE FROM setting')

    this.stmtListProbes = this.db.prepare('SELECT * FROM service_probe ORDER BY id ASC')
    this.stmtInsertProbe = this.db.prepare(`
      INSERT INTO service_probe (name, type, target, interval_sec, timeout_ms, expect_status,
                                 expect_keyword, max_latency_ms, notify_group_id, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtUpdateProbe = this.db.prepare(`
      UPDATE service_probe SET
        name = ?, type = ?, target = ?, interval_sec = ?, timeout_ms = ?, expect_status = ?,
        expect_keyword = ?, max_latency_ms = ?, notify_group_id = ?, enabled = ?
      WHERE id = ?
    `)
    this.stmtDeleteProbe = this.db.prepare('DELETE FROM service_probe WHERE id = ?')
    this.stmtDeleteProbeResults = this.db.prepare('DELETE FROM probe_result WHERE probe_id = ?')
    this.stmtInsertProbeResult = this.db.prepare(`
      INSERT INTO probe_result (probe_id, ts, ok, latency_ms, status_code, error, cert_days)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(probe_id, ts) DO UPDATE SET
        ok = excluded.ok, latency_ms = excluded.latency_ms, status_code = excluded.status_code,
        error = excluded.error, cert_days = excluded.cert_days
    `)
    // Drop everything older than the newest PROBE_KEEP rows: OFFSET counts from
    // the descending end, so the row at that offset is the cutoff.
    this.stmtTrimProbeResults = this.db.prepare(`
      DELETE FROM probe_result
      WHERE probe_id = ? AND ts <= (
        SELECT ts FROM probe_result WHERE probe_id = ? ORDER BY ts DESC LIMIT 1 OFFSET ?
      )
    `)
    this.stmtProbeResults = this.db.prepare(
      'SELECT ts, ok, latency_ms, status_code, error, cert_days FROM probe_result WHERE probe_id = ? ORDER BY ts DESC LIMIT ?',
    )
    this.stmtLatestProbeResults = this.db.prepare(`
      SELECT probe_id, ts, ok, latency_ms, status_code, error, cert_days
      FROM probe_result p
      WHERE ts = (SELECT MAX(ts) FROM probe_result q WHERE q.probe_id = p.probe_id)
    `)
    // Uptime is derived from the samples themselves: a host that answers writes a
    // row every sweep, a host that does not answer writes nothing. Counting rows
    // per hour therefore measures availability without a second bookkeeping table
    // that could disagree with the raw data.
    this.stmtHourlyCoverage = this.db.prepare(`
      SELECT alias, (ts / 3600000) AS hour, COUNT(*) AS samples
      FROM sample WHERE ts >= ? GROUP BY alias, hour
    `)
    this.stmtListCronTasks = this.db.prepare('SELECT * FROM cron_task ORDER BY id')
    this.stmtInsertCronTask = this.db.prepare(`
      INSERT INTO cron_task (name, schedule, command, cover, timeout_ms, notify_group_id, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtUpdateCronTask = this.db.prepare(`
      UPDATE cron_task SET name = ?, schedule = ?, command = ?, cover = ?, timeout_ms = ?,
        notify_group_id = ?, enabled = ? WHERE id = ?
    `)
    this.stmtDeleteCronTask = this.db.prepare('DELETE FROM cron_task WHERE id = ?')
    this.stmtDeleteCronRunsForTask = this.db.prepare('DELETE FROM cron_run WHERE task_id = ?')
    this.stmtInsertCronRun = this.db.prepare(`
      INSERT INTO cron_run (task_id, ts, total, ok_count, duration_ms, output) VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.stmtTrimCronRuns = this.db.prepare(`
      DELETE FROM cron_run WHERE task_id = ?1 AND id NOT IN (
        SELECT id FROM cron_run WHERE task_id = ?1 ORDER BY ts DESC LIMIT ?2
      )
    `)
    this.stmtListCronRuns = this.db.prepare(
      'SELECT * FROM cron_run WHERE task_id = ? ORDER BY ts DESC LIMIT ?',
    )
    this.stmtLatestCronRun = this.db.prepare(
      'SELECT * FROM cron_run WHERE task_id = ? ORDER BY ts DESC LIMIT 1',
    )
    this.stmtMarkCronRun = this.db.prepare('UPDATE cron_task SET last_run_at = ?, last_ok = ? WHERE id = ?')
    this.stmtListAlertRules = this.db.prepare('SELECT * FROM alert_rule ORDER BY id')
    this.stmtInsertAlertRule = this.db.prepare(`
      INSERT INTO alert_rule (name, metric, op, threshold, duration_sec, scope, notify_group_id, cooldown_sec, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtUpdateAlertRule = this.db.prepare(`
      UPDATE alert_rule SET name = ?, metric = ?, op = ?, threshold = ?, duration_sec = ?, scope = ?,
        notify_group_id = ?, cooldown_sec = ?, enabled = ? WHERE id = ?
    `)
    this.stmtDeleteAlertRule = this.db.prepare('DELETE FROM alert_rule WHERE id = ?')
    this.stmtDeleteAlertEventsForRule = this.db.prepare('DELETE FROM alert_event WHERE rule_id = ?')
    this.stmtOpenEvent = this.db.prepare(`
      INSERT INTO alert_event (rule_id, alias, state, started_at, peak, last_value, message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtCloseEvent = this.db.prepare('UPDATE alert_event SET state = ?, ended_at = ?, last_value = ? WHERE id = ?')
    this.stmtOpenEvents = this.db.prepare(
      'SELECT * FROM alert_event WHERE ended_at IS NULL ORDER BY started_at DESC',
    )
    this.stmtListEvents = this.db.prepare('SELECT * FROM alert_event ORDER BY started_at DESC LIMIT ?')
    this.stmtListChannels = this.db.prepare('SELECT * FROM notify_channel ORDER BY id')
    this.stmtInsertChannel = this.db.prepare(`
      INSERT INTO notify_channel (name, url, method, body_type, headers, body, verify_tls, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmtUpdateChannel = this.db.prepare(`
      UPDATE notify_channel SET name = ?, url = ?, method = ?, body_type = ?, headers = ?, body = ?,
        verify_tls = ?, enabled = ? WHERE id = ?
    `)
    this.stmtDeleteChannel = this.db.prepare('DELETE FROM notify_channel WHERE id = ?')
    this.stmtListGroups = this.db.prepare('SELECT * FROM notify_group ORDER BY id')
    this.stmtInsertGroup = this.db.prepare('INSERT INTO notify_group (name) VALUES (?)')
    this.stmtUpdateGroup = this.db.prepare('UPDATE notify_group SET name = ? WHERE id = ?')
    this.stmtDeleteGroup = this.db.prepare('DELETE FROM notify_group WHERE id = ?')
    this.stmtListGroupChannels = this.db.prepare('SELECT group_id, channel_id FROM notify_group_channel ORDER BY group_id, channel_id')
    this.stmtAddGroupChannel = this.db.prepare('INSERT OR IGNORE INTO notify_group_channel (group_id, channel_id) VALUES (?, ?)')
    this.stmtDeleteGroupChannels = this.db.prepare('DELETE FROM notify_group_channel WHERE group_id = ?')
    this.stmtDeleteGroupChannelByChannel = this.db.prepare('DELETE FROM notify_group_channel WHERE channel_id = ?')
  }

  /** Insert or update a node row. */
  upsertNode(node) {
    this.stmtUpsertNode.run(
      node.alias, node.host, node.port, node.user, node.source, node.status,
      node.lastOk ?? null, node.lastError ?? null, node.latencyMs ?? null,
      node.osName ?? null, node.kernel ?? null, node.arch ?? null,
      node.cores ?? null, node.cpuModel ?? null, Date.now(),
    )
  }

  /** Append one sample and prune the node's tail. */
  insertSample(alias, row) {
    this.stmtInsertSample.run(
      alias, row.ts, row.cpuPct ?? null, row.load1 ?? null, row.load5 ?? null, row.load15 ?? null,
      row.memUsed ?? null, row.memTotal ?? null, row.swapUsed ?? null, row.swapTotal ?? null,
      row.diskUsed ?? null, row.diskTotal ?? null, row.rxBps ?? null, row.txBps ?? null,
      row.rxBytes ?? null, row.txBytes ?? null, row.tcp ?? null, row.udp ?? null,
      row.procs ?? null, row.uptimeSec ?? null,
      row.cpuTotal ?? null, row.cpuIdle ?? null, row.ctxSwitches ?? null,
      row.tempMax ?? null, row.gpuUtil ?? null, row.gpuMemUsed ?? null,
      row.gpuMemTotal ?? null, row.listenPorts ?? null,
    )
    this.stmtPrune.run(alias, alias, this.keep)
  }

  /** The previous sample for a node, or undefined. */
  previous(alias) {
    return this.stmtPrevious.get(alias)
  }

  /** Every node with its latest sample. */
  latestAll() {
    return this.stmtLatest.all()
  }

  /** Samples for one node at or after `fromMs`, newest first. */
  history(alias, fromMs, limit) {
    return this.stmtHistory.all(alias, fromMs, limit)
  }

  /** Drop a node and its history (a host removed from every source). */
  forget(alias) {
    this.stmtDeleteSamples.run(alias)
    this.stmtDeleteNode.run(alias)
  }

  /** Hosts the operator added from the panel. */
  listManaged() {
    return this.stmtListManaged.all().map(decodeManagedRow)
  }

  /** Insert or replace one operator-added host. */
  upsertManaged(row) {
    const now = Date.now()
    this.stmtUpsertManaged.run(
      row.alias, row.host, row.port, row.user, row.authKind,
      row.keyPath ?? null, row.passphrase ?? null, row.password ?? null,
      JSON.stringify(row.tags ?? []), row.note ?? null, row.groupName ?? null,
      row.createdAt ?? now, now,
    )
  }

  /** Remove one operator-added host. Measurement rows are left to `forget`. */
  deleteManaged(alias) {
    this.stmtDeleteManaged.run(alias)
  }

  // ---------------------------------------------------------------- 5m rollup

  /**
   * Write one 5-minute bucket.
   *
   * Overwrites rather than merges: the collector accumulates the bucket in memory
   * and writes the whole row each time a sample lands inside it, so the last write
   * of a bucket is the complete aggregate. A merge here would double-count after
   * the bucket was rebuilt from raw samples following a restart.
   */
  upsertSample5m(alias, row) {
    this.stmtUpsertSample5m.run(
      alias, row.ts, row.cpuPct ?? null, row.memUsed ?? null, row.memTotal ?? null,
      row.diskUsed ?? null, row.diskTotal ?? null, row.rxBps ?? null, row.txBps ?? null,
      row.load1 ?? null, row.tcp ?? null, row.procs ?? null,
      row.tempMax ?? null, row.gpuUtil ?? null,
    )
  }

  /** Rolled-up samples for one node, newest first. */
  sample5m(alias, fromMs, limit) {
    return this.stmtSample5m.all(alias, fromMs, limit)
  }

  /**
   * Raw samples inside a time window, used to rebuild an in-memory bucket after a
   * restart so the bucket spanning the restart does not split into two halves.
   */
  bucketSamples(alias, fromMs) {
    return this.stmtBucketSamples.all(alias, fromMs)
  }

  /** Drop rollups older than the retention cutoff. */
  pruneSample5m(beforeMs) {
    this.stmtPruneSample5m.run(beforeMs)
  }

  // -------------------------------------------------------------- daily rollup

  /**
   * Add one node-observation to today's row.
   * @param alias - node alias.
   * @param day - local calendar day, `YYYY-MM-DD`.
   * @param delta - one sample's contribution; bytes are already differenced and
   *   validated by the caller, so this only accumulates.
   */
  bumpDaily(alias, day, delta = {}) {
    this.stmtBumpDaily.run(
      alias, day, delta.up === true ? 1 : 0,
      Math.max(0, Math.round(delta.rxBytes ?? 0)),
      Math.max(0, Math.round(delta.txBytes ?? 0)),
    )
  }

  /** Daily rows at or after a day string, oldest first. */
  dailyStats(fromDay) {
    return this.stmtDailyStats.all(fromDay)
  }

  /** Drop daily rows older than the cutoff day string. */
  pruneDaily(beforeDay) {
    this.stmtPruneDaily.run(beforeDay)
  }

  // --------------------------------------------------------------- host metadata

  /** Every metadata row, as camelCase records. */
  listMeta() {
    return this.stmtListMeta.all().map(decodeMetaRow)
  }

  /** Insert or update metadata for one alias. */
  upsertMeta(row) {
    this.stmtUpsertMeta.run(
      row.alias, row.displayName ?? null, row.groupName ?? null,
      JSON.stringify(row.tags ?? []), row.note ?? null,
      row.displayIndex ?? 0, row.hidden === true ? 1 : 0,
      row.expireAt ?? null, row.price ?? null, row.bandwidthGb ?? null,
      Date.now(),
    )
  }

  /** Remove metadata for one alias. */
  deleteMeta(alias) {
    this.stmtDeleteMeta.run(alias)
  }

  // ----------------------------------------------------------- hardware snapshot

  /** Latest slow-probe result for every node. */
  listHardware() {
    return this.stmtListHardware.all().map(decodeHardwareRow)
  }

  /** Latest slow-probe result for one node, or undefined. */
  hardwareFor(alias) {
    const row = this.stmtHardwareFor.get(alias)
    return row === undefined ? undefined : decodeHardwareRow(row)
  }

  /** Replace the snapshot for one node. */
  upsertHardware(alias, row) {
    this.stmtUpsertHardware.run(
      alias, row.ts ?? Date.now(), row.tempMax ?? null,
      JSON.stringify(row.sensors ?? []),
      row.gpu?.util ?? null, row.gpu?.memUsed ?? null, row.gpu?.memTotal ?? null, row.gpu?.name ?? null,
      row.listenPorts ?? null, JSON.stringify(row.listenList ?? []),
      JSON.stringify(row.partitions ?? []), JSON.stringify(row.nics ?? []),
      row.error ?? null,
    )
  }

  // ---------------------------------------------------------------- settings

  /**
   * Operator overrides, as stored. Values are JSON so a list survives a round
   * trip; a row that will not parse is dropped rather than allowed to take the
   * panel down, because the database is an ordinary file anyone can edit.
   */
  readSettings() {
    const out = {}
    for (const row of this.stmtListSettings.all()) {
      try {
        out[row.key] = JSON.parse(row.value)
      } catch {
        // One corrupt row must not hide every other setting.
      }
    }
    return out
  }

  /** Merge these values over the stored overrides and return the result. */
  writeSettings(values) {
    const now = Date.now()
    for (const [key, value] of Object.entries(values)) {
      this.stmtUpsertSetting.run(key, JSON.stringify(value), now)
    }
    return this.readSettings()
  }

  /** Drop every override, returning the plugin to the host config. */
  clearSettings() {
    this.stmtClearSettings.run()
    return {}
  }

  // ------------------------------------------------------------- service probes

  /** Every configured probe, oldest first. */
  listProbes() {
    return this.stmtListProbes.all().map(decodeProbeRow)
  }

  /**
   * Insert or update one probe.
   * @returns the row id the probe lives under.
   */
  upsertProbe(row) {
    const fields = [
      row.name, row.type, row.target, row.intervalSec ?? 60, row.timeoutMs ?? 5000,
      row.expectStatus ?? null, row.expectKeyword ?? null, row.maxLatencyMs ?? 0,
      row.notifyGroupId ?? null, row.enabled === false ? 0 : 1,
    ]
    if (row.id === undefined || row.id === null) {
      const result = this.stmtInsertProbe.run(...fields, Date.now())
      return Number(result.lastInsertRowid)
    }
    this.stmtUpdateProbe.run(...fields, row.id)
    return Number(row.id)
  }

  /** Remove a probe and everything it measured. */
  deleteProbe(id) {
    this.stmtDeleteProbeResults.run(id)
    return this.stmtDeleteProbe.run(id).changes > 0
  }

  /** Append one measurement, then trim the probe back to its ring size. */
  insertProbeResult(probeId, row) {
    this.stmtInsertProbeResult.run(
      probeId, row.ts ?? Date.now(), row.ok === true ? 1 : 0,
      row.latencyMs ?? null, row.statusCode ?? null, row.error ?? null, row.certDays ?? null,
    )
    this.stmtTrimProbeResults.run(probeId, probeId, PROBE_KEEP)
  }

  /** The newest `limit` measurements, oldest first — the grid the panel draws. */
  probeResults(probeId, limit = PROBE_GRID) {
    return this.stmtProbeResults.all(probeId, limit).map(decodeProbeResult).reverse()
  }

  /** The newest measurement of every probe, keyed by probe id. */
  latestProbeResults() {
    const out = new Map()
    for (const row of this.stmtLatestProbeResults.all()) out.set(row.probe_id, decodeProbeResult(row))
    return out
  }

  /**
   * Sample counts per clock hour, keyed by alias.
   *
   * The caller turns these into an uptime percentage: an hour with 120 samples of
   * a 30 second interval was fully up, an hour with 30 was up for a quarter of it.
   * Hours with no row at all are absent rather than zero so the reader can tell
   * "nobody collected" from "the host was down" — after a shutdown the whole
   * window is missing, and painting that as an outage would be a lie.
   */
  hourlyCoverage(sinceMs) {
    const out = new Map()
    for (const row of this.stmtHourlyCoverage.all(sinceMs)) {
      let list = out.get(row.alias)
      if (list === undefined) {
        list = []
        out.set(row.alias, list)
      }
      list.push({ hour: row.hour, samples: row.samples })
    }
    return out
  }

  /* ── scheduled tasks ─────────────────────────────────────────────────── */

  listCronTasks() {
    return this.stmtListCronTasks.all().map(decodeCronTaskRow)
  }

  upsertCronTask(row) {
    const stamp = Date.now()
    if (row.id === undefined || row.id === null) {
      const result = this.stmtInsertCronTask.run(
        row.name,
        row.schedule,
        row.command,
        JSON.stringify(row.cover ?? { mode: 'all', aliases: [] }),
        row.timeoutMs ?? 60_000,
        row.notifyGroupId ?? null,
        row.enabled === false ? 0 : 1,
        stamp,
      )
      return Number(result.lastInsertRowid)
    }
    this.stmtUpdateCronTask.run(
      row.name,
      row.schedule,
      row.command,
      JSON.stringify(row.cover ?? { mode: 'all', aliases: [] }),
      row.timeoutMs ?? 60_000,
      row.notifyGroupId ?? null,
      row.enabled === false ? 0 : 1,
      row.id,
    )
    return row.id
  }

  deleteCronTask(id) {
    this.stmtDeleteCronRunsForTask.run(Number(id))
    return this.stmtDeleteCronTask.run(Number(id)).changes > 0
  }

  /** Record one execution and keep the newest `CRON_RUN_KEEP` of that task. */
  insertCronRun(taskId, row) {
    const result = this.stmtInsertCronRun.run(
      Number(taskId),
      row.ts ?? Date.now(),
      row.total ?? 0,
      row.okCount ?? 0,
      row.durationMs ?? 0,
      row.output ?? '',
    )
    this.stmtTrimCronRuns.run(Number(taskId), CRON_RUN_KEEP)
    return Number(result.lastInsertRowid)
  }

  listCronRuns(taskId, limit = 50) {
    return this.stmtListCronRuns.all(Number(taskId), limit).map(decodeCronRunRow)
  }

  latestCronRun(taskId) {
    const row = this.stmtLatestCronRun.get(Number(taskId))
    return row === undefined ? null : decodeCronRunRow(row)
  }

  markCronRun(taskId, ts, ok) {
    this.stmtMarkCronRun.run(ts, ok ? 1 : 0, Number(taskId))
  }

  /* ── alert rules ─────────────────────────────────────────────────────── */

  listAlertRules() {
    return this.stmtListAlertRules.all().map(decodeAlertRuleRow)
  }

  /**
   * Insert or update one rule.
   *
   * Updating keeps `created_at`: a rule's age is not its last edit time, and the
   * settings page sorts on when it was first written.
   */
  upsertAlertRule(row) {
    const scope = JSON.stringify(row.scope ?? { mode: 'all', aliases: [] })
    const fields = [
      row.name,
      row.metric,
      row.op ?? 'gt',
      row.threshold,
      row.durationSec ?? 180,
      scope,
      row.notifyGroupId ?? null,
      row.cooldownSec ?? 1800,
      row.enabled === false ? 0 : 1,
    ]
    if (row.id === undefined || row.id === null) {
      const result = this.stmtInsertAlertRule.run(...fields, Date.now())
      return Number(result.lastInsertRowid)
    }
    this.stmtUpdateAlertRule.run(...fields, row.id)
    return row.id
  }

  deleteAlertRule(id) {
    this.stmtDeleteAlertEventsForRule.run(id)
    return this.stmtDeleteAlertRule.run(id).changes > 0
  }

  /* ── alert events ────────────────────────────────────────────────────── */

  /** Open an event and return its id; the caller stores that id in its state map. */
  openEvent(rule, alias, value, peak, message) {
    const result = this.stmtOpenEvent.run(
      rule.id,
      alias,
      'firing',
      Date.now(),
      peak === undefined ? null : peak,
      value === undefined ? null : value,
      message ?? null,
    )
    return Number(result.lastInsertRowid)
  }

  /** Close an event; a missing id is a no-op rather than an error. */
  closeEvent(eventId, value) {
    if (eventId === undefined || eventId === null) return
    this.stmtCloseEvent.run('resolved', Date.now(), value === undefined ? null : value, eventId)
  }

  /** Events still open — the engine replays these on startup so a restart keeps firing. */
  openEvents() {
    return this.stmtOpenEvents.all().map(decodeAlertEventRow)
  }

  /** Recent events, newest first. */
  listEvents(limit = 100) {
    return this.stmtListEvents.all(limit).map(decodeAlertEventRow)
  }

  /* ── notification channels and groups ────────────────────────────────── */

  listNotifyChannels() {
    return this.stmtListChannels.all().map(decodeChannelRow)
  }

  upsertNotifyChannel(row) {
    const fields = [
      row.name,
      row.url,
      (row.method ?? 'POST').toUpperCase(),
      row.bodyType ?? 'json',
      typeof row.headers === 'string' ? row.headers : JSON.stringify(row.headers ?? {}),
      row.body ?? null,
      row.verifyTls === false || row.verifyTls === 0 ? 0 : 1,
      row.enabled === false ? 0 : 1,
    ]
    if (row.id === undefined || row.id === null) {
      return Number(this.stmtInsertChannel.run(...fields, Date.now()).lastInsertRowid)
    }
    this.stmtUpdateChannel.run(...fields, row.id)
    return row.id
  }

  deleteNotifyChannel(id) {
    this.stmtDeleteGroupChannelByChannel.run(id)
    return this.stmtDeleteChannel.run(id).changes > 0
  }

  listNotifyGroups() {
    const channels = this.stmtListGroupChannels.all()
    const byGroup = new Map()
    for (const row of channels) {
      const list = byGroup.get(row.group_id) ?? []
      list.push(row.channel_id)
      byGroup.set(row.group_id, list)
    }
    return this.stmtListGroups.all().map((row) => ({
      id: row.id,
      name: row.name,
      channelIds: byGroup.get(row.id) ?? [],
    }))
  }

  upsertNotifyGroup(row) {
    if (row.id === undefined || row.id === null) {
      const id = Number(this.stmtInsertGroup.run(row.name).lastInsertRowid)
      this.setGroupChannels(id, row.channelIds ?? [])
      return id
    }
    this.stmtUpdateGroup.run(row.name, row.id)
    if (Array.isArray(row.channelIds)) this.setGroupChannels(row.id, row.channelIds)
    return row.id
  }

  deleteNotifyGroup(id) {
    this.stmtDeleteGroupChannels.run(id)
    return this.stmtDeleteGroup.run(id).changes > 0
  }

  /** Replace a group's channel set in one transaction. */
  setGroupChannels(groupId, channelIds) {
    this.stmtDeleteGroupChannels.run(groupId)
    for (const channelId of channelIds) {
      if (Number.isInteger(channelId)) this.stmtAddGroupChannel.run(groupId, channelId)
    }
  }

  /** Channels that belong to one group, resolved to full rows. */
  channelsForGroup(groupId) {
    if (groupId === undefined || groupId === null) return []
    const ids = new Set(this.listNotifyGroups().find((group) => group.id === groupId)?.channelIds ?? [])
    return this.listNotifyChannels().filter((channel) => ids.has(channel.id) && channel.enabled)
  }

  /** Flush and close. */
  close() {
    try {
      this.db.close()
    } catch {
      // A close failure on shutdown is not actionable.
    }
  }
}

/**
 * Memory + JSON-snapshot fallback. Same interface, shorter history, and it
 * says why it is in use so the panel can explain the reduced range.
 */
class JsonStore {
  /** @param path - snapshot location. @param keep - retained samples per node. */
  constructor(path, keep) {
    this.backend = 'json'
    this.keep = keep
    this.path = path
    this.nodes = new Map()
    this.samples = new Map()
    this.managed = new Map()
    this.samples5m = new Map()
    this.daily = new Map()
    this.meta = new Map()
    this.hardware = new Map()
    this.probes = new Map()
    // Named `resultsByProbe` rather than `probeResults`: the latter is the public
    // method further down, and a field of the same name would shadow it.
    this.resultsByProbe = new Map()
    this.nextProbeId = 1
    this.alertRules = new Map()
    this.alertEvents = []
    this.channels = new Map()
    this.groups = new Map()
    this.nextRuleId = 1
    this.nextEventId = 1
    this.nextChannelId = 1
    this.nextGroupId = 1
    this.cronTasks = new Map()
    this.cronRuns = new Map()
    this.nextTaskId = 1
    this.nextRunId = 1
    this.settings = {}
    this.dirty = false
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        for (const node of parsed.nodes ?? []) this.nodes.set(node.alias, node)
        for (const [alias, rows] of Object.entries(parsed.samples ?? {})) this.samples.set(alias, rows)
        for (const row of parsed.managed ?? []) this.managed.set(row.alias, row)
        for (const [alias, rows] of Object.entries(parsed.samples5m ?? {})) this.samples5m.set(alias, rows)
        for (const row of parsed.daily ?? []) this.daily.set(`${row.alias}\u0000${row.day}`, row)
        for (const row of parsed.meta ?? []) this.meta.set(row.alias, row)
        for (const row of parsed.hardware ?? []) this.hardware.set(row.alias, row)
        for (const row of parsed.probes ?? []) {
          this.probes.set(row.id, row)
          if (row.id >= this.nextProbeId) this.nextProbeId = row.id + 1
        }
        for (const [id, rows] of Object.entries(parsed.probeResults ?? {})) this.resultsByProbe.set(Number(id), rows)
        for (const row of parsed.alertRules ?? []) {
          this.alertRules.set(row.id, row)
          if (row.id >= this.nextRuleId) this.nextRuleId = row.id + 1
        }
        for (const row of parsed.alertEvents ?? []) {
          this.alertEvents.push(row)
          if (row.id >= this.nextEventId) this.nextEventId = row.id + 1
        }
        for (const row of parsed.channels ?? []) {
          this.channels.set(row.id, row)
          if (row.id >= this.nextChannelId) this.nextChannelId = row.id + 1
        }
        for (const row of parsed.groups ?? []) {
          this.groups.set(row.id, row)
          if (row.id >= this.nextGroupId) this.nextGroupId = row.id + 1
        }
        for (const row of parsed.cronTasks ?? []) {
          this.cronTasks.set(row.id, row)
          if (row.id >= this.nextTaskId) this.nextTaskId = row.id + 1
        }
        for (const [id, rows] of Object.entries(parsed.cronRuns ?? {})) {
          this.cronRuns.set(Number(id), rows)
          for (const row of rows) if (row.id >= this.nextRunId) this.nextRunId = row.id + 1
        }
        this.settings = parsed.settings ?? {}
      }
    } catch {
      // A corrupt snapshot costs history, not the panel.
    }
    this.timer = setInterval(() => this.flush(), 30_000)
    this.timer.unref?.()
  }

  /** Persist the snapshot when something changed. */
  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify({
        nodes: [...this.nodes.values()],
        samples: Object.fromEntries(this.samples),
        managed: [...this.managed.values()],
        samples5m: Object.fromEntries(this.samples5m),
        daily: [...this.daily.values()],
        meta: [...this.meta.values()],
        hardware: [...this.hardware.values()],
        probes: [...this.probes.values()],
        probeResults: Object.fromEntries(this.resultsByProbe),
        alertRules: [...this.alertRules.values()],
        alertEvents: this.alertEvents,
        channels: [...this.channels.values()],
        groups: [...this.groups.values()],
        cronTasks: [...this.cronTasks.values()],
        cronRuns: Object.fromEntries(this.cronRuns),
        settings: this.settings,
      }), { mode: 0o600 })
    } catch {
      // Persisting history is best-effort.
    }
  }

  upsertNode(node) {
    this.nodes.set(node.alias, { ...node, updatedAt: Date.now() })
    this.dirty = true
  }

  insertSample(alias, row) {
    const rows = this.samples.get(alias) ?? []
    // Stored in the SQL column shape so both backends hand the routes, the tools
    // and the collector the *same* row keys; nothing downstream branches on
    // which store is live.
    rows.push({
      alias,
      ts: row.ts,
      cpu_pct: row.cpuPct ?? null,
      load1: row.load1 ?? null,
      load5: row.load5 ?? null,
      load15: row.load15 ?? null,
      mem_used: row.memUsed ?? null,
      mem_total: row.memTotal ?? null,
      swap_used: row.swapUsed ?? null,
      swap_total: row.swapTotal ?? null,
      disk_used: row.diskUsed ?? null,
      disk_total: row.diskTotal ?? null,
      rx_bps: row.rxBps ?? null,
      tx_bps: row.txBps ?? null,
      rx_bytes: row.rxBytes ?? null,
      tx_bytes: row.txBytes ?? null,
      tcp: row.tcp ?? null,
      udp: row.udp ?? null,
      procs: row.procs ?? null,
      uptime_sec: row.uptimeSec ?? null,
      cpu_total: row.cpuTotal ?? null,
      cpu_idle: row.cpuIdle ?? null,
      ctx_switches: row.ctxSwitches ?? null,
      temp_max: row.tempMax ?? null,
      gpu_util: row.gpuUtil ?? null,
      gpu_mem_used: row.gpuMemUsed ?? null,
      gpu_mem_total: row.gpuMemTotal ?? null,
      listen_ports: row.listenPorts ?? null,
    })
    while (rows.length > this.keep) rows.shift()
    this.samples.set(alias, rows)
    this.dirty = true
  }

  previous(alias) {
    const rows = this.samples.get(alias)
    return rows === undefined || rows.length === 0 ? undefined : rows[rows.length - 1]
  }

  latestAll() {
    const out = []
    for (const node of this.nodes.values()) {
      const rows = this.samples.get(node.alias) ?? []
      const last = rows[rows.length - 1]
      out.push(last === undefined ? { ...node } : {
        ...node,
        sample_ts: last.ts,
        cpu_pct: last.cpu_pct,
        load1: last.load1,
        load5: last.load5,
        load15: last.load15,
        mem_used: last.mem_used,
        mem_total: last.mem_total,
        swap_used: last.swap_used,
        swap_total: last.swap_total,
        disk_used: last.disk_used,
        disk_total: last.disk_total,
        rx_bps: last.rx_bps,
        tx_bps: last.tx_bps,
        rx_bytes: last.rx_bytes,
        tx_bytes: last.tx_bytes,
        tcp: last.tcp,
        udp: last.udp,
        procs: last.procs,
        uptime_sec: last.uptime_sec,
      })
    }
    return out.sort((a, b) => a.alias.localeCompare(b.alias))
  }

  history(alias, fromMs, limit) {
    const rows = this.samples.get(alias) ?? []
    return rows.filter(row => row.ts >= fromMs).slice(-limit).reverse()
  }

  forget(alias) {
    this.nodes.delete(alias)
    this.samples.delete(alias)
    this.dirty = true
  }

  listManaged() {
    return [...this.managed.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  }

  upsertManaged(row) {
    const now = Date.now()
    const existing = this.managed.get(row.alias)
    this.managed.set(row.alias, {
      alias: row.alias,
      host: row.host,
      port: row.port,
      user: row.user,
      authKind: row.authKind,
      keyPath: row.keyPath ?? null,
      passphrase: row.passphrase ?? null,
      password: row.password ?? null,
      tags: row.tags ?? [],
      note: row.note ?? null,
      groupName: row.groupName ?? null,
      createdAt: existing?.createdAt ?? row.createdAt ?? now,
      updatedAt: now,
    })
    this.dirty = true
  }

  deleteManaged(alias) {
    this.managed.delete(alias)
    this.dirty = true
  }

  // ---------------------------------------------------------------- 5m rollup
  //
  // The JSON backend exists so a host without `node:sqlite` keeps working. It is
  // not the long-term store, so the rollup retention is generous but bounded:
  // this.samples5m holds one array per alias, oldest first, same column names as
  // the SQLite table.

  upsertSample5m(alias, row) {
    const rows = this.samples5m.get(alias) ?? []
    const record = {
      alias,
      ts: row.ts,
      cpu_pct: row.cpuPct ?? null,
      mem_used: row.memUsed ?? null,
      mem_total: row.memTotal ?? null,
      disk_used: row.diskUsed ?? null,
      disk_total: row.diskTotal ?? null,
      rx_bps: row.rxBps ?? null,
      tx_bps: row.txBps ?? null,
      load1: row.load1 ?? null,
      tcp: row.tcp ?? null,
      procs: row.procs ?? null,
      temp_max: row.tempMax ?? null,
      gpu_util: row.gpuUtil ?? null,
    }
    const at = rows.findIndex(candidate => candidate.ts === record.ts)
    if (at === -1) rows.push(record)
    else rows[at] = record
    rows.sort((a, b) => a.ts - b.ts)
    while (rows.length > JSON_KEEP_5M) rows.shift()
    this.samples5m.set(alias, rows)
    this.dirty = true
  }

  sample5m(alias, fromMs, limit) {
    const rows = this.samples5m.get(alias) ?? []
    const window = rows.filter(row => row.ts >= fromMs)
    const cap = Number.isFinite(limit) && limit > 0 ? limit : window.length
    return window.slice(-cap).reverse()
  }

  bucketSamples(alias, fromMs) {
    const rows = this.samples.get(alias) ?? []
    return rows.filter(row => row.ts >= fromMs)
  }

  pruneSample5m(beforeMs) {
    for (const [alias, rows] of this.samples5m) {
      const kept = rows.filter(row => row.ts >= beforeMs)
      if (kept.length === 0) this.samples5m.delete(alias)
      else this.samples5m.set(alias, kept)
    }
    this.dirty = true
  }

  // -------------------------------------------------------------- daily rollup

  bumpDaily(alias, day, delta = {}) {
    const key = `${alias}\u0000${day}`
    const existing = this.daily.get(key) ?? {
      alias, day, samples: 0, up_samples: 0, rx_bytes: 0, tx_bytes: 0,
    }
    this.daily.set(key, {
      alias,
      day,
      samples: existing.samples + 1,
      up_samples: existing.up_samples + (delta.up === true ? 1 : 0),
      rx_bytes: existing.rx_bytes + Math.max(0, Math.round(delta.rxBytes ?? 0)),
      tx_bytes: existing.tx_bytes + Math.max(0, Math.round(delta.txBytes ?? 0)),
    })
    this.dirty = true
  }

  dailyStats(fromDay) {
    return [...this.daily.values()]
      .filter(row => row.day >= fromDay)
      .sort((a, b) => (a.day === b.day ? a.alias.localeCompare(b.alias) : a.day.localeCompare(b.day)))
  }

  pruneDaily(beforeDay) {
    for (const [key, row] of this.daily) if (row.day < beforeDay) this.daily.delete(key)
    this.dirty = true
  }

  // --------------------------------------------------------------- host metadata

  listMeta() {
    return [...this.meta.values()].sort((a, b) => {
      const order = (a.displayIndex ?? 0) - (b.displayIndex ?? 0)
      return order === 0 ? a.alias.localeCompare(b.alias) : order
    })
  }

  upsertMeta(row) {
    const now = Date.now()
    this.meta.set(row.alias, {
      alias: row.alias,
      displayName: row.displayName ?? null,
      groupName: row.groupName ?? null,
      tags: row.tags ?? [],
      note: row.note ?? null,
      displayIndex: row.displayIndex ?? 0,
      hidden: row.hidden === true,
      expireAt: row.expireAt ?? null,
      price: row.price ?? null,
      bandwidthGb: row.bandwidthGb ?? null,
      updatedAt: now,
    })
    this.dirty = true
  }

  deleteMeta(alias) {
    this.meta.delete(alias)
    this.dirty = true
  }

  // ---------------------------------------------------------------- settings

  readSettings() {
    return { ...this.settings }
  }

  writeSettings(values) {
    this.settings = { ...this.settings, ...values }
    this.dirty = true
    return this.readSettings()
  }

  clearSettings() {
    this.settings = {}
    this.dirty = true
    return {}
  }

  // ----------------------------------------------------------- hardware snapshot

  listHardware() {
    return [...this.hardware.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  }

  hardwareFor(alias) {
    return this.hardware.get(alias)
  }

  upsertHardware(alias, row) {
    this.hardware.set(alias, {
      alias,
      ts: row.ts ?? Date.now(),
      tempMax: row.tempMax ?? null,
      sensors: row.sensors ?? [],
      gpu: row.gpu ?? null,
      listenPorts: row.listenPorts ?? null,
      listenList: row.listenList ?? [],
      partitions: row.partitions ?? [],
      nics: row.nics ?? [],
      error: row.error ?? null,
    })
    this.dirty = true
  }

  // ------------------------------------------------------------- service probes

  listProbes() {
    return [...this.probes.values()].sort((a, b) => a.id - b.id)
  }

  upsertProbe(row) {
    const id = row.id ?? this.nextProbeId
    if (row.id === undefined || row.id === null) this.nextProbeId += 1
    const previous = this.probes.get(id)
    this.probes.set(id, {
      id,
      name: row.name,
      type: Number(row.type),
      target: row.target,
      intervalSec: row.intervalSec ?? 60,
      timeoutMs: row.timeoutMs ?? 5000,
      expectStatus: row.expectStatus ?? null,
      expectKeyword: row.expectKeyword ?? null,
      maxLatencyMs: row.maxLatencyMs ?? 0,
      notifyGroupId: row.notifyGroupId ?? null,
      enabled: row.enabled !== false,
      createdAt: previous?.createdAt ?? Date.now(),
    })
    this.dirty = true
    return id
  }

  deleteProbe(id) {
    const key = Number(id)
    const existed = this.probes.delete(key)
    this.resultsByProbe.delete(key)
    if (existed) this.dirty = true
    return existed
  }

  insertProbeResult(probeId, row) {
    const key = Number(probeId)
    const rows = this.resultsByProbe.get(key) ?? []
    const entry = {
      ts: row.ts ?? Date.now(),
      ok: row.ok === true,
      latencyMs: row.latencyMs ?? null,
      statusCode: row.statusCode ?? null,
      error: row.error ?? null,
      certDays: row.certDays ?? null,
    }
    const at = rows.findIndex(candidate => candidate.ts === entry.ts)
    if (at === -1) rows.push(entry)
    else rows[at] = entry
    rows.sort((a, b) => a.ts - b.ts)
    if (rows.length > PROBE_KEEP) rows.splice(0, rows.length - PROBE_KEEP)
    this.resultsByProbe.set(key, rows)
    this.dirty = true
  }

  probeResults(probeId, limit = PROBE_GRID) {
    const rows = this.resultsByProbe.get(Number(probeId)) ?? []
    return rows.slice(-limit)
  }

  latestProbeResults() {
    const out = new Map()
    for (const [id, rows] of this.resultsByProbe) {
      const last = rows[rows.length - 1]
      if (last !== undefined) out.set(id, last)
    }
    return out
  }

  /** Same contract as the SQLite reader: per-clock-hour sample counts. */
  hourlyCoverage(sinceMs) {
    const out = new Map()
    for (const [alias, rows] of this.samples) {
      const buckets = new Map()
      for (const row of rows) {
        if (row.ts < sinceMs) continue
        const hour = Math.floor(row.ts / 3_600_000)
        buckets.set(hour, (buckets.get(hour) ?? 0) + 1)
      }
      if (buckets.size > 0) {
        out.set(alias, [...buckets.entries()].map(([hour, samples]) => ({ hour, samples })))
      }
    }
    return out
  }

  /* ── scheduled tasks (JSON backend) ──────────────────────────────────── */

  listCronTasks() {
    return [...this.cronTasks.values()].sort((left, right) => left.id - right.id)
  }

  upsertCronTask(row) {
    this.dirty = true
    if (row.id === undefined || row.id === null) {
      const id = this.nextTaskId
      this.nextTaskId += 1
      this.cronTasks.set(id, {
        id,
        name: row.name,
        schedule: row.schedule,
        command: row.command,
        cover: row.cover ?? { mode: 'all', aliases: [] },
        timeoutMs: row.timeoutMs ?? 60_000,
        notifyGroupId: row.notifyGroupId ?? null,
        enabled: row.enabled !== false,
        lastRunAt: null,
        lastOk: null,
        createdAt: Date.now(),
      })
      return id
    }
    const existing = this.cronTasks.get(Number(row.id))
    this.cronTasks.set(Number(row.id), {
      ...existing,
      id: Number(row.id),
      name: row.name,
      schedule: row.schedule,
      command: row.command,
      cover: row.cover ?? { mode: 'all', aliases: [] },
      timeoutMs: row.timeoutMs ?? 60_000,
      notifyGroupId: row.notifyGroupId ?? null,
      enabled: row.enabled !== false,
    })
    return Number(row.id)
  }

  deleteCronTask(id) {
    this.dirty = true
    this.cronRuns.delete(Number(id))
    return this.cronTasks.delete(Number(id))
  }

  insertCronRun(taskId, row) {
    this.dirty = true
    const id = this.nextRunId
    this.nextRunId += 1
    const key = Number(taskId)
    const rows = this.cronRuns.get(key) ?? []
    const total = row.total ?? 0
    const okCount = row.okCount ?? 0
    rows.unshift({
      id,
      taskId: key,
      ts: row.ts ?? Date.now(),
      total,
      okCount,
      // Same derived field the SQLite decoder produces: a partial failure is a
      // failure, and the panel reads this one boolean.
      ok: total > 0 && okCount === total,
      durationMs: row.durationMs ?? 0,
      output: row.output ?? '',
    })
    if (rows.length > CRON_RUN_KEEP) rows.length = CRON_RUN_KEEP
    this.cronRuns.set(key, rows)
    return id
  }

  listCronRuns(taskId, limit = 50) {
    return (this.cronRuns.get(Number(taskId)) ?? []).slice(0, limit)
  }

  latestCronRun(taskId) {
    const rows = this.cronRuns.get(Number(taskId))
    return rows === undefined || rows.length === 0 ? null : rows[0]
  }

  markCronRun(taskId, ts, ok) {
    const task = this.cronTasks.get(Number(taskId))
    if (task === undefined) return
    this.dirty = true
    this.cronTasks.set(Number(taskId), { ...task, lastRunAt: ts, lastOk: ok === true })
  }

  /* ── alert rules (JSON backend) ──────────────────────────────────────── */

  listAlertRules() {
    return [...this.alertRules.values()].sort((left, right) => left.id - right.id)
  }

  upsertAlertRule(row) {
    const id = row.id === undefined || row.id === null ? this.nextRuleId++ : row.id
    const previous = this.alertRules.get(id)
    this.alertRules.set(id, {
      id,
      name: row.name,
      metric: row.metric,
      op: row.op ?? 'gt',
      threshold: row.threshold,
      durationSec: row.durationSec ?? 180,
      scope: row.scope ?? { mode: 'all', aliases: [] },
      notifyGroupId: row.notifyGroupId ?? null,
      cooldownSec: row.cooldownSec ?? 1800,
      enabled: row.enabled !== false,
      createdAt: previous?.createdAt ?? Date.now(),
    })
    this.dirty = true
    return id
  }

  deleteAlertRule(id) {
    const existed = this.alertRules.delete(id)
    this.alertEvents = this.alertEvents.filter((event) => event.ruleId !== id)
    this.dirty = true
    return existed
  }

  /* ── alert events (JSON backend) ─────────────────────────────────────── */

  openEvent(rule, alias, value, peak, message) {
    const id = this.nextEventId++
    this.alertEvents.push({
      id,
      ruleId: rule.id,
      alias,
      state: 'firing',
      startedAt: Date.now(),
      endedAt: null,
      peak: peak === undefined ? null : peak,
      lastValue: value === undefined ? null : value,
      message: message ?? null,
    })
    this.dirty = true
    return id
  }

  closeEvent(eventId, value) {
    const event = this.alertEvents.find((row) => row.id === eventId)
    if (event === undefined) return
    event.state = 'resolved'
    event.endedAt = Date.now()
    event.lastValue = value === undefined ? null : value
    this.dirty = true
  }

  openEvents() {
    return this.alertEvents.filter((event) => event.endedAt === null)
  }

  listEvents(limit = 100) {
    return [...this.alertEvents].sort((left, right) => right.startedAt - left.startedAt).slice(0, limit)
  }

  /* ── notification channels and groups (JSON backend) ─────────────────── */

  listNotifyChannels() {
    return [...this.channels.values()].sort((left, right) => left.id - right.id)
  }

  upsertNotifyChannel(row) {
    const id = row.id === undefined || row.id === null ? this.nextChannelId++ : row.id
    const previous = this.channels.get(id)
    this.channels.set(id, {
      id,
      name: row.name,
      url: row.url,
      method: (row.method ?? 'POST').toUpperCase(),
      bodyType: row.bodyType ?? 'json',
      headers: typeof row.headers === 'string' ? row.headers : JSON.stringify(row.headers ?? {}),
      body: row.body ?? '',
      verifyTls: row.verifyTls !== false && row.verifyTls !== 0,
      enabled: row.enabled !== false,
      createdAt: previous?.createdAt ?? Date.now(),
    })
    this.dirty = true
    return id
  }

  deleteNotifyChannel(id) {
    const existed = this.channels.delete(id)
    for (const group of this.groups.values()) {
      group.channelIds = group.channelIds.filter((channelId) => channelId !== id)
    }
    this.dirty = true
    return existed
  }

  listNotifyGroups() {
    return [...this.groups.values()]
      .sort((left, right) => left.id - right.id)
      .map((group) => ({ id: group.id, name: group.name, channelIds: [...group.channelIds] }))
  }

  upsertNotifyGroup(row) {
    const id = row.id === undefined || row.id === null ? this.nextGroupId++ : row.id
    const previous = this.groups.get(id)
    this.groups.set(id, {
      id,
      name: row.name,
      channelIds: Array.isArray(row.channelIds) ? [...row.channelIds] : (previous?.channelIds ?? []),
    })
    this.dirty = true
    return id
  }

  deleteNotifyGroup(id) {
    const existed = this.groups.delete(id)
    this.dirty = true
    return existed
  }

  setGroupChannels(groupId, channelIds) {
    const group = this.groups.get(groupId)
    if (group === undefined) return
    group.channelIds = channelIds.filter((channelId) => Number.isInteger(channelId))
    this.dirty = true
  }

  channelsForGroup(groupId) {
    if (groupId === undefined || groupId === null) return []
    const group = this.groups.get(groupId)
    if (group === undefined) return []
    const wanted = new Set(group.channelIds)
    return this.listNotifyChannels().filter((channel) => wanted.has(channel.id) && channel.enabled)
  }

  close() {
    clearInterval(this.timer)
    this.flush()
  }
}
