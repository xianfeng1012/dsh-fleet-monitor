/**
 * SFTP browsing, on the connection the monitor already keeps open.
 *
 * Paths are resolved to absolute POSIX paths and confined to `fsRoots` before
 * anything touches SFTP. The real boundary is the SSH account itself — this
 * plugin can only do what that account can — but an accidental `../../../etc`
 * typed into a file input should fail here rather than at the filesystem.
 */

import { posix } from 'node:path'

import { resolveAuth } from './hosts.js'

/** How long an idle SFTP session is kept before the channel is released. */
const SFTP_IDLE_MS = 120_000

/** Default ceilings; both are configuration fields. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
export const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/**
 * Normalise a panel-supplied path and confirm it lives under an allowed root.
 * @param raw - the path the browser asked for.
 * @param roots - absolute prefixes it may reach.
 * @returns the absolute POSIX path.
 */
export function resolveRemotePath(raw, roots) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error('path is required')
  if (text.includes('\0')) throw new Error('invalid path')
  // `posix.normalize` collapses `a/../../b` to `../b`, so the check below sees
  // the escape rather than the disguising segments. It keeps a trailing slash,
  // which would make `/var/log/` and `/var/log` two different keys.
  const normalised = posix.normalize(`/${text.replace(/^\.\/+/, '')}`)
  const absolute = normalised.length > 1 && normalised.endsWith('/')
    ? normalised.slice(0, -1)
    : normalised
  if (absolute === '/..' || absolute.startsWith('/../')) {
    throw new Error('path traversal is not allowed')
  }
  const list = Array.isArray(roots) && roots.length > 0 ? roots : ['/']
  const allowed = list.some((root) => (
    absolute === root || absolute.startsWith(root.endsWith('/') ? root : `${root}/`)
  ))
  if (!allowed) throw new Error(`path outside allowed roots (${list.join(', ')})`)
  return absolute
}

/** The POSIX parent of an absolute path, for the "up" entry. */
export function parentPath(absolute) {
  if (absolute === '/' || absolute === '') return '/'
  const cut = absolute.lastIndexOf('/')
  return cut <= 0 ? '/' : absolute.slice(0, cut)
}

/** A stable sort: directories first, then names, locale-aware. */
function compareEntries(left, right) {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
  return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

/**
 * Turn one SFTP directory entry into the shape the panel renders.
 * @param entry - `{ filename, longname, attrs }` as ssh2 reports it.
 * @param base - the directory it came from.
 */
export function describeEntry(entry, base) {
  const attrs = entry.attrs ?? {}
  const mode = typeof attrs.mode === 'number' ? attrs.mode : 0
  const kind = mode & 0o170000
  const isDirectory = kind === 0o040000
  const isSymlink = kind === 0o120000
  return {
    name: entry.filename,
    path: base === '/' ? `/${entry.filename}` : `${base}/${entry.filename}`,
    isDirectory,
    isSymlink,
    size: isDirectory ? null : (attrs.size ?? null),
    mtime: attrs.mtime === undefined ? null : attrs.mtime * 1000,
    mode: mode === 0 ? null : `0${(mode & 0o777).toString(8)}`,
  }
}

export class FileBrowser {
  /**
   * @param deps.pool - the SSH connection pool.
   * @param deps.collector - resolves an alias to a host definition.
   * @param deps.getConfig - live configuration.
   */
  constructor({ pool, collector, getConfig }) {
    this.pool = pool
    this.collector = collector
    this.getConfig = getConfig
    this.sessions = new Map()
    this.disposed = false
    // An SFTP channel holds a slot on the remote sshd; a browser left open on a
    // directory should not keep one until the plugin unloads.
    this.reaper = setInterval(() => this.reap(), 60_000)
    if (typeof this.reaper.unref === 'function') this.reaper.unref()
  }

  /** @returns the host record, or undefined when the alias is not configured. */
  hostFor(alias) {
    return this.collector.hosts.find((host) => host.alias === alias)
  }

  roots() {
    const config = this.getConfig() ?? {}
    return Array.isArray(config.fsRoots) && config.fsRoots.length > 0 ? config.fsRoots : ['/']
  }

  /** Resolve an alias to an SFTP session, reusing the cached channel. */
  async session(alias) {
    const cached = this.sessions.get(alias)
    if (cached !== undefined) {
      cached.at = Date.now()
      return cached.sftp
    }
    const definition = this.hostFor(alias)
    if (definition === undefined) throw new Error(`unknown alias: ${alias}`)
    if (Array.isArray(definition.proxyJump) && definition.proxyJump.length > 0) {
      throw new Error('proxy jump not supported for file browsing')
    }
    const config = this.getConfig() ?? {}
    const auth = resolveAuth(definition, {
      connectTimeoutMs: config.connectTimeoutMs,
      agentSocket: config.agentSocket === '' ? undefined : config.agentSocket,
    })
    const pooled = await this.pool.connectionFor(definition, auth)
    const connection = pooled.conn
    if (connection === null || connection === undefined) {
      throw new Error('the pooled connection is not open')
    }
    const sftp = await new Promise((resolve, reject) => {
      connection.sftp((error, channel) => {
        if (error) { reject(error); return }
        resolve(channel)
      })
    })
    const entry = { sftp, at: Date.now() }
    this.sessions.set(alias, entry)
    return sftp
  }

  /** Drop sessions that have been idle, and close them. */
  reap() {
    const now = Date.now()
    for (const [alias, entry] of this.sessions) {
      if (now - entry.at < SFTP_IDLE_MS) continue
      this.sessions.delete(alias)
      try { entry.sftp.end() } catch {}
    }
  }

  async list(alias, rawPath) {
    const target = resolveRemotePath(rawPath ?? '/', this.roots())
    const sftp = await this.session(alias)
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(target, (error, list) => {
        if (error) { reject(error); return }
        resolve(list)
      })
    })
    const described = entries.map((entry) => describeEntry(entry, target)).sort(compareEntries)
    return { path: target, parent: parentPath(target), entries: described }
  }

  async stat(alias, rawPath) {
    const target = resolveRemotePath(rawPath, this.roots())
    const sftp = await this.session(alias)
    const attrs = await new Promise((resolve, reject) => {
      sftp.lstat(target, (error, value) => {
        if (error) { reject(error); return }
        resolve(value)
      })
    })
    return {
      path: target,
      name: posix.basename(target),
      size: attrs.size ?? null,
      mtime: attrs.mtime === undefined ? null : attrs.mtime * 1000,
      isDirectory: (attrs.mode & 0o170000) === 0o040000,
      mode: attrs.mode === undefined ? null : `0${(attrs.mode & 0o777).toString(8)}`,
    }
  }

  async mkdir(alias, rawPath) {
    const target = resolveRemotePath(rawPath, this.roots())
    const sftp = await this.session(alias)
    await new Promise((resolve, reject) => {
      sftp.mkdir(target, (error) => { if (error) reject(error); else resolve() })
    })
    return { path: target }
  }

  async rename(alias, fromRaw, toRaw) {
    const from = resolveRemotePath(fromRaw, this.roots())
    const to = resolveRemotePath(toRaw, this.roots())
    const sftp = await this.session(alias)
    await new Promise((resolve, reject) => {
      sftp.rename(from, to, (error) => { if (error) reject(error); else resolve() })
    })
    return { from, to }
  }

  async remove(alias, rawPath, recursive) {
    const target = resolveRemotePath(rawPath, this.roots())
    if (target === '/') throw new Error('refusing to delete the root directory')
    const sftp = await this.session(alias)
    await this.removeAt(sftp, target, recursive === true, 0)
    return { path: target }
  }

  /** Delete one entry, descending when asked. Depth-limited so a link loop ends. */
  async removeAt(sftp, target, recursive, depth) {
    if (depth > 32) throw new Error('directory nesting is too deep')
    const attrs = await new Promise((resolve, reject) => {
      sftp.lstat(target, (error, value) => { if (error) reject(error); else resolve(value) })
    })
    if ((attrs.mode & 0o170000) === 0o040000) {
      const entries = await new Promise((resolve, reject) => {
        sftp.readdir(target, (error, list) => { if (error) reject(error); else resolve(list) })
      })
      if (entries.length > 0 && !recursive) throw new Error('directory is not empty')
      for (const entry of entries) {
        await this.removeAt(sftp, `${target}/${entry.filename}`, recursive, depth + 1)
      }
      await new Promise((resolve, reject) => {
        sftp.rmdir(target, (error) => { if (error) reject(error); else resolve() })
      })
      return
    }
    await new Promise((resolve, reject) => {
      sftp.unlink(target, (error) => { if (error) reject(error); else resolve() })
    })
  }

  /**
   * Stream a remote file to an HTTP response.
   * @returns the number of bytes queued, once the stream ends.
   */
  async download(alias, rawPath, response) {
    const target = resolveRemotePath(rawPath, this.roots())
    const limit = this.getConfig()?.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
    const sftp = await this.session(alias)
    const attrs = await new Promise((resolve, reject) => {
      sftp.stat(target, (error, value) => { if (error) reject(error); else resolve(value) })
    })
    if ((attrs.mode & 0o170000) === 0o040000) throw new Error('path is a directory')
    if (attrs.size !== undefined && attrs.size > limit) {
      const failure = new Error(`file is ${attrs.size} bytes, over the ${limit} byte limit`)
      failure.code = 'TOO_LARGE'
      throw failure
    }
    const name = posix.basename(target)
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      ...(attrs.size === undefined ? {} : { 'content-length': String(attrs.size) }),
      // `filename*` carries non-ASCII names; the plain form keeps older clients working.
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    })
    return await new Promise((resolve, reject) => {
      const stream = sftp.createReadStream(target)
      stream.on('error', (error) => { response.destroy(); reject(error) })
      stream.on('end', () => resolve(attrs.size ?? null))
      stream.pipe(response)
    })
  }

  /**
   * Read a raw request body into a remote file, emitting NDJSON progress.
   *
   * The body is the file itself, not a multipart form: a form would have to be
   * parsed and buffered before anything reached the remote side, which is
   * exactly what a progress bar is supposed to avoid.
   */
  async upload(alias, rawPath, request, response) {
    const target = resolveRemotePath(rawPath, this.roots())
    const limit = this.getConfig()?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
    const sftp = await this.session(alias)
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    })
    const emit = (payload) => {
      try { response.write(`${JSON.stringify(payload)}\n`) } catch {}
    }
    const stream = sftp.createWriteStream(target)
    let received = 0
    let lastEmit = 0
    let closed = false
    const finish = (payload) => {
      if (closed) return
      closed = true
      emit(payload)
      try { response.end() } catch {}
    }
    return await new Promise((resolve) => {
      stream.on('error', (error) => {
        finish({ type: 'result', ok: false, error: error.message, received })
        resolve({ ok: false, received })
      })
      request.on('data', (chunk) => {
        if (closed) return
        received += chunk.length
        if (received > limit) {
          const reason = `upload over the ${limit} byte limit`
          emit({ type: 'result', ok: false, error: reason, received })
          closed = true
          try { request.destroy() } catch {}
          try { stream.destroy() } catch {}
          try { response.end() } catch {}
          resolve({ ok: false, received, error: reason })
          return
        }
        stream.write(chunk)
        const now = Date.now()
        if (now - lastEmit > 200) {
          lastEmit = now
          const declared = Number(request.headers['content-length'] ?? 0)
          emit({ type: 'progress', received, total: Number.isFinite(declared) ? declared : null })
        }
      })
      request.on('aborted', () => {
        closed = true
        try { stream.destroy() } catch {}
        resolve({ ok: false, received })
      })
      request.on('end', () => {
        stream.end(() => {
          finish({ type: 'result', ok: true, received, path: target })
          resolve({ ok: true, received })
        })
      })
    })
  }

  dispose() {
    this.disposed = true
    if (this.reaper !== undefined) clearInterval(this.reaper)
    for (const [, entry] of this.sessions) {
      try { entry.sftp.end() } catch {}
    }
    this.sessions.clear()
  }
}
