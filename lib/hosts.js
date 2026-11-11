/**
 * Host discovery. A monitoring plugin is only worth installing if it works
 * against hosts the operator **already** has, so nothing here asks for a new
 * inventory: it reads the two places an SSH user already keeps one.
 *
 * 1. `$DSH_HOME/dsh-ssh.json` — the host store of the dsh-ssh plugin, when that
 *    plugin is installed. Credentials (password / key path / passphrase) come
 *    with it, so those hosts work with zero further setup. Read-only: this
 *    plugin never writes that file.
 * 2. `~/.ssh/config` — the plain OpenSSH client config, for anyone who has not
 *    installed dsh-ssh. `IdentityFile` is honoured; a passphrase-protected key
 *    needs `ssh-agent` (see {@link resolveAuth}).
 *
 * Hosts configured through this plugin's own settings win over both, so an
 * operator can override a user name or disable a host without editing files
 * another tool owns.
 *
 * A host reached from two sources is deduplicated by `user@host:port`, keeping
 * the higher-priority entry, so a machine does not appear twice in the panel.
 *
 * @module dsh-fleet-monitor/hosts
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Priority used when the same `user@host:port` comes from two sources. */
const SOURCE_RANK = { panel: 4, manual: 3, 'dsh-ssh': 2, 'ssh-config': 1 }

/**
 * Resolve the dsh home directory the way the host does.
 * @param override - an explicit path from plugin config, if any.
 * @returns the directory holding `dsh-ssh.json`.
 */
export function resolveDshHome(override) {
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/**
 * Collect every host this plugin may poll, from all three sources.
 *
 * A missing or unparsable source is skipped rather than fatal: a malformed
 * `~/.ssh/config` must not take the whole panel down, and a fresh install has
 * neither file.
 * @param options - discovery inputs.
 * @param options.dshHome - override for `$DSH_HOME`.
 * @param options.sshDir - override for `~/.ssh`.
 * @param options.manual - hosts declared in this plugin's settings.
 * @param options.panel - hosts the operator added from the panel (owned rows).
 * @returns deduplicated hosts, highest priority first, with `problems` listing
 *   every source that could not be read.
 */
export function discoverHosts(options = {}) {
  const dshHome = resolveDshHome(options.dshHome)
  const sshDir = options.sshDir ?? join(homedir(), '.ssh')
  const problems = []
  const candidates = []

  // Rows added in the panel outrank every imported source: an operator who edits
  // a host's port in the UI expects that value to win over a stale dsh-ssh entry.
  for (const host of Array.isArray(options.panel) ? options.panel : []) {
    const normalised = normalisePanelHost(host)
    if (normalised === undefined) {
      problems.push(`panel host entry rejected: ${JSON.stringify(host)}`)
      continue
    }
    candidates.push(normalised)
  }

  for (const host of Array.isArray(options.manual) ? options.manual : []) {
    const normalised = normaliseManual(host)
    if (normalised === undefined) {
      problems.push(`manual host entry rejected: ${JSON.stringify(host)}`)
      continue
    }
    candidates.push(normalised)
  }

  const dshHosts = readDshSshStore(dshHome, problems)
  candidates.push(...dshHosts)

  const configHosts = readSshConfig(sshDir, problems)
  candidates.push(...configHosts)

  // Deduplicate by connection identity. A later (lower priority) source is
  // dropped, but its tags still merge so a `prod` label from ssh_config is not
  // lost when dsh-ssh knows the same machine.
  const byKey = new Map()
  for (const host of candidates) {
    const key = `${host.user}@${host.host.toLowerCase()}:${host.port}`
    const existing = byKey.get(key)
    if (existing === undefined || SOURCE_RANK[host.source] > SOURCE_RANK[existing.source]) {
      if (existing !== undefined) host.tags = [...new Set([...host.tags, ...existing.tags])]
      byKey.set(key, host)
    } else {
      existing.tags = [...new Set([...existing.tags, ...host.tags])]
    }
  }

  const hosts = [...byKey.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  return { hosts, problems }
}

/**
 * Read the dsh-ssh plugin's host store.
 * @param dshHome - resolved `$DSH_HOME`.
 * @param problems - sink for read/parse failures.
 * @returns hosts with their stored credentials.
 */
function readDshSshStore(dshHome, problems) {
  const file = join(dshHome, 'dsh-ssh.json')
  if (!existsSync(file)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    problems.push(`dsh-ssh.json unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const list = Array.isArray(parsed?.hosts) ? parsed.hosts : Array.isArray(parsed) ? parsed : []
  const out = []
  for (const entry of list) {
    if (typeof entry?.host !== 'string' || entry.host === '') continue
    out.push({
      alias: typeof entry.alias === 'string' && entry.alias !== '' ? entry.alias : `${entry.user ?? 'root'}@${entry.host}`,
      host: entry.host,
      port: Number.isInteger(entry.port) && entry.port > 0 ? entry.port : 22,
      user: typeof entry.user === 'string' && entry.user !== '' ? entry.user : 'root',
      auth: sanitiseAuth(entry.auth),
      proxyJump: Array.isArray(entry.proxyJump) ? entry.proxyJump.filter(a => typeof a === 'string') : [],
      description: typeof entry.description === 'string' ? entry.description : undefined,
      tags: Array.isArray(entry.tags) ? entry.tags.filter(t => typeof t === 'string') : [],
      source: 'dsh-ssh',
    })
  }
  return out
}

/** Keep only the auth fields this plugin knows how to use. */
function sanitiseAuth(auth) {
  if (auth === null || typeof auth !== 'object') return { kind: 'agent' }
  const kind = auth.kind === 'password' || auth.kind === 'key' || auth.kind === 'agent' ? auth.kind : 'agent'
  return {
    kind,
    password: typeof auth.password === 'string' ? auth.password : undefined,
    keyPath: typeof auth.keyPath === 'string' ? auth.keyPath : undefined,
    passphrase: typeof auth.passphrase === 'string' ? auth.passphrase : undefined,
    agentPath: typeof auth.agentPath === 'string' ? auth.agentPath : undefined,
  }
}

/**
 * Hosts the operator added from the panel are already validated on write; this
 * only re-checks the fields a hand-edited database row could have broken.
 * @param row - one `managed_host` record.
 * @returns the host, or undefined when it has no hostname.
 */
function normalisePanelHost(row) {
  if (row === null || typeof row !== 'object') return undefined
  if (typeof row.host !== 'string' || row.host.trim() === '') return undefined
  const alias = typeof row.alias === 'string' && row.alias.trim() !== '' ? row.alias.trim() : row.host.trim()
  return {
    alias,
    host: row.host.trim(),
    port: Number.isInteger(row.port) && row.port > 0 ? row.port : 22,
    user: typeof row.user === 'string' && row.user.trim() !== '' ? row.user.trim() : 'root',
    auth: sanitiseAuth({
      kind: row.authKind,
      password: row.password,
      keyPath: row.keyPath,
      passphrase: row.passphrase,
    }),
    proxyJump: [],
    description: typeof row.note === 'string' && row.note !== '' ? row.note : undefined,
    group: typeof row.groupName === 'string' && row.groupName !== '' ? row.groupName : undefined,
    tags: Array.isArray(row.tags) ? row.tags.filter(tag => typeof tag === 'string') : [],
    managed: true,
    source: 'panel',
  }
}

/**
 * Hosts declared in this plugin's own settings are already normalised by the
 * config schema; this only rejects entries the schema could not validate.
 * @param host - one settings entry.
 * @returns the host, or undefined when it has no hostname.
 */
function normaliseManual(host) {
  if (host === null || typeof host !== 'object') return undefined
  if (typeof host.host !== 'string' || host.host.trim() === '') return undefined
  return {
    alias: typeof host.alias === 'string' && host.alias.trim() !== '' ? host.alias.trim() : host.host.trim(),
    host: host.host.trim(),
    port: Number.isInteger(host.port) && host.port > 0 ? host.port : 22,
    user: typeof host.user === 'string' && host.user.trim() !== '' ? host.user.trim() : 'root',
    auth: sanitiseAuth(host.auth),
    proxyJump: [],
    description: typeof host.description === 'string' ? host.description : undefined,
    tags: ['manual'],
    source: 'manual',
  }
}

/**
 * Parse an OpenSSH client config.
 *
 * This is a deliberately small subset: `Host`, `HostName`, `Port`, `User`,
 * `IdentityFile`. It does **not** implement `Match`, `Include`, wildcards or
 * `%h` token expansion, because a monitoring host whose identity depends on
 * `Match exec` cannot be polled predictably — such blocks are skipped and
 * reported instead of guessed at.
 * @param sshDir - directory holding the config.
 * @param problems - sink for skipped blocks.
 * @returns one host per literal `Host` block that names a resolvable hostname.
 */
export function readSshConfig(sshDir, problems = []) {
  const file = join(sshDir, 'config')
  if (!existsSync(file)) return []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    problems.push(`ssh config unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const out = []
  let current
  const flush = () => {
    if (current === undefined) return
    if (current.patterns.length === 1 && !/[*?!]/.test(current.patterns[0])) {
      const alias = current.patterns[0]
      const host = current.hostName ?? alias
      out.push({
        alias,
        host,
        port: current.port ?? 22,
        user: current.user ?? 'root',
        auth: current.identityFile !== undefined
          ? { kind: 'key', keyPath: expandTilde(current.identityFile, sshDir) }
          : { kind: 'agent' },
        proxyJump: [],
        tags: ['ssh-config'],
        source: 'ssh-config',
      })
    } else if (current.patterns.length > 0) {
      problems.push(`ssh config block skipped (wildcard or Match, not pollable): ${current.patterns.join(' ')}`)
    }
    current = undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const stripped = stripComment(line).trim()
    if (stripped === '') continue
    const match = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(stripped) ?? /^([A-Za-z]+)\s+(.*)$/.exec(stripped)
    if (match === null) continue
    const keyword = match[1].toLowerCase()
    const value = match[2].trim()
    if (keyword === 'host') {
      flush()
      current = { patterns: value.split(/\s+/).filter(p => p !== ''), hostName: undefined, port: undefined, user: undefined, identityFile: undefined }
      continue
    }
    if (keyword === 'match') {
      flush()
      problems.push('ssh config Match block skipped (not pollable)')
      continue
    }
    if (current === undefined) continue
    if (keyword === 'hostname') current.hostName = value
    else if (keyword === 'port') {
      const port = Number(value)
      if (Number.isInteger(port) && port > 0) current.port = port
    } else if (keyword === 'user') current.user = value
    else if (keyword === 'identityfile') current.identityFile = value
  }
  flush()
  return out
}

/** Strip an inline `#` comment that is not inside quotes. */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

/** Expand a leading `~` in an IdentityFile value. */
function expandTilde(value, sshDir) {
  const trimmed = value.replace(/^"(.*)"$/, '$1')
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(join(homedir(), trimmed.slice(1)))
  }
  return isAbsolute(trimmed) ? trimmed : resolve(join(sshDir, trimmed))
}

/**
 * Map a discovered host to the `ssh2` connect options.
 *
 * A `key` auth entry whose file is missing falls back to `agent` rather than
 * failing every poll forever: the key may simply have moved, and the operator
 * can still be authenticated by an agent they have loaded.
 * @param host - one entry from {@link discoverHosts}.
 * @param context - resolution inputs.
 * @param context.connectTimeoutMs - TCP connect + handshake ceiling.
 * @param context.agentSocket - `SSH_AUTH_SOCK`-equivalent to use when the host
 *   asks for agent auth and carries no explicit `agentPath`.
 * @returns ssh2 `ConnectConfig`.
 */
export function resolveAuth(host, context = {}) {
  const base = {
    host: host.host,
    port: host.port,
    username: host.user,
    readyTimeout: context.connectTimeoutMs ?? 15_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 2,
  }
  const auth = host.auth ?? { kind: 'agent' }
  if (auth.kind === 'password' && typeof auth.password === 'string') {
    return { ...base, password: auth.password }
  }
  if (auth.kind === 'key' && typeof auth.keyPath === 'string') {
    try {
      const key = readFileSync(auth.keyPath)
      return { ...base, privateKey: key, passphrase: auth.passphrase }
    } catch {
      // Fall through to agent auth.
    }
  }
  const agent = auth.agentPath ?? context.agentSocket
  return agent === undefined ? { ...base } : { ...base, agent }
}
