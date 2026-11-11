/**
 * Schema and migrations for the history store.
 *
 * Kept apart from `store.js` for one reason: every migration decision belongs in
 * one place. A store that grows tables step by step starts to hide `ALTER`
 * statements inside feature code, and then nobody can tell which columns a given
 * database file actually has. Everything that changes shape lives here.
 *
 * Two rules this file obeys, both learned the hard way:
 *
 * 1. No backticks anywhere in these strings. The DDL is a template literal, and a
 *    backtick inside a SQL comment terminates it early — which reads as
 *    "SyntaxError: missing ) after argument list" at import time, not as a SQL
 *    error, so the stack points at the wrong line.
 * 2. Every statement is `IF NOT EXISTS` and every added column is probed first.
 *    The database is a plain file the operator can open with any tool, and a
 *    plugin upgrade must never be able to fail because of what it finds there.
 *
 * @module dsh-fleet-monitor/store-schema
 */

/**
 * Tables that existed before the Nezha-parity work.
 *
 * `sample` is declared here with its original columns only; later columns arrive
 * through `migrateSample` so an existing 24-hour database keeps its rows.
 */
export const BASE_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS node (
    alias TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    user TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    last_ok INTEGER,
    last_error TEXT,
    latency_ms INTEGER,
    os_name TEXT,
    kernel TEXT,
    arch TEXT,
    cores INTEGER,
    cpu_model TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sample (
    alias TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cpu_pct REAL,
    load1 REAL, load5 REAL, load15 REAL,
    mem_used INTEGER, mem_total INTEGER, swap_used INTEGER, swap_total INTEGER,
    disk_used INTEGER, disk_total INTEGER,
    rx_bps REAL, tx_bps REAL, rx_bytes INTEGER, tx_bytes INTEGER,
    tcp INTEGER, udp INTEGER, procs INTEGER, uptime_sec INTEGER,
    -- Monotonic counters are stored raw so the NEXT poll can difference them.
    -- Keeping only the derived rate would make a missed sample unrecoverable.
    cpu_total INTEGER, cpu_idle INTEGER, ctx_switches INTEGER,
    -- Filled from the slow probe, never by the fast one: they exist here so a
    -- single query can chart temperature and GPU next to CPU without a join.
    temp_max REAL,
    gpu_util REAL, gpu_mem_used INTEGER, gpu_mem_total INTEGER,
    listen_ports INTEGER,
    PRIMARY KEY (alias, ts)
  );
  CREATE INDEX IF NOT EXISTS sample_ts ON sample(ts);

  -- Hosts added from the panel. Separate from the measurement table because a
  -- node row is a measurement, while this is operator intent: it must survive
  -- pruning, and it is the only host source the plugin itself owns
  -- (dsh-ssh.json and ~/.ssh/config stay read-only imports).
  CREATE TABLE IF NOT EXISTS managed_host (
    alias TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    user TEXT NOT NULL,
    auth_kind TEXT NOT NULL,
    key_path TEXT,
    passphrase TEXT,
    password TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    group_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

/**
 * Columns appended to `sample` after the first release.
 *
 * All five come from the slow probe (5-minute cadence), never from the fast one:
 * a fast sweep must stay one cheap round-trip. They are filled from
 * `host_hardware` when the fast sample is written, which is why the fast path
 * never has to wait for hardware collection.
 */
const SAMPLE_EXTRA_COLUMNS = [
  ['temp_max', 'REAL'],
  ['gpu_util', 'REAL'],
  ['gpu_mem_used', 'INTEGER'],
  ['gpu_mem_total', 'INTEGER'],
  ['listen_ports', 'INTEGER'],
]

/**
 * Tables added for the Nezha-parity feature set.
 *
 * Grouped by the section of the spec that owns them so a reader can jump back.
 * Nothing here is pruned by the sample retention loop; each table that grows
 * without bound carries its own retention rule in the store methods.
 */
export const EXTRA_SCHEMA = `
  -- 5-minute rollups, 30 days. Raw samples stay at 24 hours; this is what the
  -- charts read when the window is longer than a day.
  CREATE TABLE IF NOT EXISTS sample_5m (
    alias TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cpu_pct REAL, mem_used INTEGER, mem_total INTEGER,
    disk_used INTEGER, disk_total INTEGER,
    rx_bps REAL, tx_bps REAL, load1 REAL, tcp INTEGER, procs INTEGER,
    temp_max REAL, gpu_util REAL,
    PRIMARY KEY (alias, ts)
  );
  CREATE INDEX IF NOT EXISTS sample_5m_ts ON sample_5m(ts);

  -- Operator intent about a node that no host source owns: grouping, labels,
  -- expiry reminders, ordering, hiding. Keyed by alias because every other table
  -- is, and because alias is immutable (see the routes).
  CREATE TABLE IF NOT EXISTS host_meta (
    alias TEXT PRIMARY KEY,
    display_name TEXT,
    group_name TEXT,
    tags TEXT DEFAULT '[]',
    note TEXT,
    display_index INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0,
    expire_at INTEGER,
    price REAL,
    bandwidth_gb INTEGER,
    updated_at INTEGER NOT NULL
  );

  -- Latest slow-probe result per node. A snapshot, not a series: temperature and
  -- GPU at 5-minute resolution are not worth a table of rows, and the fast
  -- sample carries the latest value forward so the charts still plot it.
  CREATE TABLE IF NOT EXISTS host_hardware (
    alias TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    temp_max REAL,
    sensors TEXT DEFAULT '[]',
    gpu_util REAL,
    gpu_mem_used INTEGER,
    gpu_mem_total INTEGER,
    gpu_name TEXT,
    -- Count for the fast path and for charts; the list itself is only ever shown
    -- on the detail page, so it lives as one JSON column instead of a table.
    listen_ports INTEGER,
    listen_list TEXT DEFAULT '[]',
    partitions TEXT DEFAULT '[]',
    nics TEXT DEFAULT '[]',
    error TEXT
  );

  -- HTTP / TCP / ICMP checks, executed on the DSH host, never over SSH.
  -- A probe has no notion of servers: it asks whether a target answers, which is
  -- independent of whether that target's machine is reachable by SSH.
  CREATE TABLE IF NOT EXISTS service_probe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type INTEGER NOT NULL,
    target TEXT NOT NULL,
    interval_sec INTEGER DEFAULT 60,
    timeout_ms INTEGER DEFAULT 5000,
    expect_status TEXT,
    expect_keyword TEXT,
    max_latency_ms INTEGER DEFAULT 0,
    notify_group_id INTEGER,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  -- Bounded ring per probe: the store trims to PROBE_KEEP rows, the API returns
  -- the newest 30 as the fixed grid the panel draws.
  CREATE TABLE IF NOT EXISTS probe_result (
    probe_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    status_code INTEGER,
    error TEXT,
    cert_days INTEGER,
    PRIMARY KEY (probe_id, ts)
  );
  CREATE INDEX IF NOT EXISTS probe_result_ts ON probe_result(probe_id, ts DESC);

  CREATE TABLE IF NOT EXISTS alert_rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    metric TEXT NOT NULL,
    op TEXT NOT NULL DEFAULT 'gt',
    threshold REAL NOT NULL,
    duration_sec INTEGER DEFAULT 180,
    scope TEXT DEFAULT '{"mode":"all","aliases":[]}',
    notify_group_id INTEGER,
    cooldown_sec INTEGER DEFAULT 1800,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alert_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    alias TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    peak REAL,
    last_value REAL,
    message TEXT
  );
  CREATE INDEX IF NOT EXISTS alert_event_open ON alert_event(ended_at, started_at DESC);
  CREATE INDEX IF NOT EXISTS alert_event_rule ON alert_event(rule_id, alias, ended_at);

  -- One channel is one HTTP call: URL, method, headers, body template. There is
  -- deliberately no per-provider branch — Bark, Telegram, Lark and WeCom are all
  -- "POST this template to this URL", and a provider enum would only make new
  -- providers a code change instead of a settings change.
  CREATE TABLE IF NOT EXISTS notify_channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    method TEXT DEFAULT 'POST',
    body_type TEXT DEFAULT 'json',
    headers TEXT DEFAULT '{}',
    body TEXT,
    verify_tls INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notify_group (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notify_group_channel (
    group_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, channel_id)
  );

  -- Five-field cron, host-local time. Tasks run over the existing SSH pool, so a
  -- scheduled command costs the same as a probe round-trip.
  CREATE TABLE IF NOT EXISTS cron_task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    command TEXT NOT NULL,
    cover TEXT DEFAULT '{"mode":"all","aliases":[]}',
    timeout_ms INTEGER DEFAULT 60000,
    notify_group_id INTEGER,
    enabled INTEGER DEFAULT 1,
    last_run_at INTEGER,
    last_ok INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cron_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    total INTEGER,
    ok_count INTEGER,
    duration_ms INTEGER,
    output TEXT
  );
  CREATE INDEX IF NOT EXISTS cron_run_task ON cron_run(task_id, ts DESC);

  -- Per-day rollup, kept for a year. The panel's uptime bar reads this instead
  -- of scanning 24 hours of raw samples per node per render.
  CREATE TABLE IF NOT EXISTS daily_stat (
    alias TEXT NOT NULL,
    day TEXT NOT NULL,
    samples INTEGER DEFAULT 0,
    up_samples INTEGER DEFAULT 0,
    rx_bytes INTEGER DEFAULT 0,
    tx_bytes INTEGER DEFAULT 0,
    PRIMARY KEY (alias, day)
  );

  -- Operator overrides for values the plugin would otherwise read from the host's
  -- config. They live here rather than in the host config because a volatile()
  -- field is owned by the host loader: a plugin can read it but never write it, so
  -- a settings form that saved into it would appear to work and change nothing.
  CREATE TABLE IF NOT EXISTS setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

/**
 * Bring an existing database up to the current shape.
 *
 * @param db - an open `DatabaseSync`.
 * @returns the columns that were added, for logging; empty on a fresh install
 *   (the base DDL already declares them for a brand-new file).
 */
export function migrateSample(db) {
  const present = new Set(db.prepare('PRAGMA table_info(sample)').all().map(row => row.name))
  const added = []
  for (const [name, type] of SAMPLE_EXTRA_COLUMNS) {
    if (present.has(name)) continue
    try {
      db.exec(`ALTER TABLE sample ADD COLUMN ${name} ${type}`)
      added.push(name)
    } catch {
      // A locked or read-only file leaves the column absent; readers already
      // tolerate a missing key, so this costs the slow-probe panel, not the app.
    }
  }
  return added
}

/**
 * Create every table and apply column migrations.
 * @param db - an open `DatabaseSync`.
 * @returns the columns appended to an existing `sample` table.
 */
export function applySchema(db) {
  db.exec(BASE_SCHEMA)
  db.exec(EXTRA_SCHEMA)
  return migrateSample(db)
}
