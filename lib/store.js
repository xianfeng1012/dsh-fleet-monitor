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
    const store = new SqliteStore(new DatabaseSync(dbPath), keep)
    store.path = dbPath
    return store
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
    this.db.exec(`
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
    `)
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
         cpu_total, cpu_idle, ctx_switches)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    this.dirty = false
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        for (const node of parsed.nodes ?? []) this.nodes.set(node.alias, node)
        for (const [alias, rows] of Object.entries(parsed.samples ?? {})) this.samples.set(alias, rows)
        for (const row of parsed.managed ?? []) this.managed.set(row.alias, row)
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

  close() {
    clearInterval(this.timer)
    this.flush()
  }
}
