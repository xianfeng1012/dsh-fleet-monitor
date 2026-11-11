/**
 * The file browser, against an in-memory SFTP.
 *
 * The point of these tests is the parts that protect the remote machine: path
 * confinement, the refusal to delete a directory that is not empty, and the byte
 * ceilings. Talking to a real sshd would test ssh2, not this module.
 */

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  FileBrowser,
  describeEntry,
  parentPath,
  resolveRemotePath,
} from '../lib/fs.js'

const DIRECTORY = 0o040755
const FILE = 0o100644
const SYMLINK = 0o120777

/** A tiny in-memory filesystem with the slice of the SFTP API we call. */
function memorySftp() {
  const files = new Map([
    ['/', { mode: DIRECTORY, size: 0, mtime: 1_700_000_000 }],
    ['/etc', { mode: DIRECTORY, size: 0, mtime: 1_700_000_000 }],
    ['/etc/nginx', { mode: DIRECTORY, size: 0, mtime: 1_700_000_000 }],
    ['/etc/nginx/nginx.conf', { mode: FILE, size: 512, mtime: 1_700_000_100, body: 'user nginx;\n' }],
    ['/var', { mode: DIRECTORY, size: 0, mtime: 1_700_000_000 }],
    ['/var/log', { mode: DIRECTORY, size: 0, mtime: 1_700_000_000 }],
    ['/var/log/syslog', { mode: FILE, size: 2_048, mtime: 1_700_000_200, body: 'x'.repeat(2048) }],
    ['/var/log/current', { mode: SYMLINK, size: 7, mtime: 1_700_000_300 }],
    ['/bin', { mode: DIRECTORY, size: 0, mtime: 1_700_000_000 }],
    ['/bin/sh', { mode: FILE, size: 64, mtime: 1_700_000_000, body: '#!' }],
  ])
  const childrenOf = (path) => [...files.keys()]
    .filter((key) => key !== path && parentPath(key) === path)
    .map((key) => ({
      filename: key.slice(key.lastIndexOf('/') + 1),
      longname: '',
      attrs: { mode: files.get(key).mode, size: files.get(key).size, mtime: files.get(key).mtime },
    }))
  return {
    files,
    readdir(path, cb) {
      if (!files.has(path)) { cb(Object.assign(new Error('No such file'), { code: 2 })); return }
      cb(null, childrenOf(path))
    },
    stat(path, cb) { this.lstat(path, cb) },
    lstat(path, cb) {
      const entry = files.get(path)
      if (entry === undefined) { cb(Object.assign(new Error('No such file'), { code: 2 })); return }
      cb(null, { mode: entry.mode, size: entry.size, mtime: entry.mtime })
    },
    mkdir(path, cb) {
      if (files.has(path)) { cb(new Error('File exists')); return }
      files.set(path, { mode: DIRECTORY, size: 0, mtime: 1_700_000_000 })
      cb(null)
    },
    rename(from, to, cb) {
      const entry = files.get(from)
      if (entry === undefined) { cb(new Error('No such file')); return }
      files.delete(from)
      files.set(to, entry)
      cb(null)
    },
    unlink(path, cb) {
      if (!files.has(path)) { cb(new Error('No such file')); return }
      files.delete(path)
      cb(null)
    },
    rmdir(path, cb) {
      if (childrenOf(path).length > 0) { cb(new Error('Directory not empty')); return }
      files.delete(path)
      cb(null)
    },
    createReadStream(path) {
      const entry = files.get(path)
      const stream = new PassThrough()
      setImmediate(() => {
        if (entry === undefined) { stream.destroy(new Error('No such file')); return }
        stream.end(entry.body ?? '')
      })
      return stream
    },
    createWriteStream(path) {
      const chunks = []
      const stream = new PassThrough()
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('finish', () => {
        const body = Buffer.concat(chunks)
        files.set(path, { mode: FILE, size: body.length, mtime: Date.now(), body: body.toString('utf8') })
      })
      // `end(cb)` on a PassThrough flushes on finish; the real SFTP stream calls
      // the callback once the remote side has acknowledged the write.
      const original = stream.end.bind(stream)
      stream.end = (cb) => { original(); if (typeof cb === 'function') stream.on('finish', cb) }
      return stream
    },
    end() {},
  }
}

function makeBrowser(overrides = {}) {
  const sftp = memorySftp()
  const browser = new FileBrowser({
    pool: { connectionFor: async () => ({ conn: { sftp: (cb) => cb(null, sftp) } }) },
    collector: { hosts: [{ alias: 'web-01', proxyJump: [] }, { alias: 'jump-01', proxyJump: [{ host: 'x' }] }] },
    getConfig: () => ({ fsRoots: ['/'], ...overrides }),
  })
  return { browser, sftp }
}

test('a path is normalised and confined to the allowed roots', () => {
  assert.equal(resolveRemotePath('/var/log', ['/']), '/var/log')
  assert.equal(resolveRemotePath('var/log/', ['/']), '/var/log')
  assert.equal(resolveRemotePath('./etc/nginx', ['/']), '/etc/nginx')
  assert.equal(resolveRemotePath('/var/../etc', ['/']), '/etc')
  // The confinement is checked after normalisation, so a disguised escape is
  // still an escape.
  assert.throws(() => resolveRemotePath('../etc', ['/var']), /traversal|outside allowed roots/)
  assert.throws(() => resolveRemotePath('/etc/passwd', ['/var/log']), /outside allowed roots/)
  assert.throws(() => resolveRemotePath('', ['/']), /path is required/)
  assert.throws(() => resolveRemotePath('/var\0/log', ['/']), /invalid path/)
  assert.equal(resolveRemotePath('/var/log/syslog', ['/var/log']), '/var/log/syslog')
})

test('the parent of a path never walks above the root', () => {
  assert.equal(parentPath('/var/log/syslog'), '/var/log')
  assert.equal(parentPath('/var'), '/')
  assert.equal(parentPath('/'), '/')
  assert.equal(parentPath(''), '/')
})

test('directory entries carry what the table needs and nothing more', () => {
  const base = describeEntry(
    { filename: 'nginx', attrs: { mode: DIRECTORY, size: 4096, mtime: 1_700_000_000 } },
    '/etc',
  )
  assert.equal(base.path, '/etc/nginx')
  assert.equal(base.isDirectory, true)
  assert.equal(base.isSymbolicLink, undefined)
  assert.equal(base.size, null, 'a directory has no meaningful size')
  assert.equal(base.mode, '0755')

  const link = describeEntry({ filename: 'current', attrs: { mode: SYMLINK, size: 7 } }, '/var/log')
  assert.equal(link.path, '/var/log/current')
  assert.equal(link.isDirectory, false)
  assert.equal(link.isSymlink, true)

  const atRoot = describeEntry({ filename: 'etc', attrs: { mode: DIRECTORY } }, '/')
  assert.equal(atRoot.path, '/etc', 'the root does not double its slash')
})

test('a listing puts directories first and keeps dotfiles sortable', async () => {
  const { browser } = makeBrowser()
  const listing = await browser.list('web-01', '/var/log')
  assert.equal(listing.path, '/var/log')
  assert.equal(listing.parent, '/var')
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['current', 'syslog'])
  assert.equal(listing.entries[1].size, 2048)
  browser.dispose()
})

test('an alias that is not configured is refused before any connection', async () => {
  const { browser } = makeBrowser()
  await assert.rejects(() => browser.list('nope', '/'), /unknown alias/)
  await assert.rejects(() => browser.list('jump-01', '/'), /proxy jump/)
  browser.dispose()
})

test('deleting a non-empty directory needs the recursive flag', async () => {
  const { browser, sftp } = makeBrowser()
  await assert.rejects(() => browser.remove('web-01', '/etc', false), /not empty/)
  assert.ok(sftp.files.has('/etc/nginx/nginx.conf'), 'nothing was removed on the refused call')

  await browser.remove('web-01', '/etc', true)
  assert.equal(sftp.files.has('/etc'), false)
  assert.equal(sftp.files.has('/etc/nginx/nginx.conf'), false, 'the children went with it')
  browser.dispose()
})

test('the root directory is never deleted', async () => {
  const { browser, sftp } = makeBrowser()
  await assert.rejects(() => browser.remove('web-01', '/', true), /refusing to delete the root/)
  assert.ok(sftp.files.has('/'))
  browser.dispose()
})

test('creating and renaming keeps the tree consistent', async () => {
  const { browser, sftp } = makeBrowser()
  await browser.mkdir('web-01', '/var/log/archive')
  assert.equal(sftp.files.get('/var/log/archive').mode, DIRECTORY)
  await browser.rename('web-01', '/var/log/syslog', '/var/log/syslog.1')
  assert.equal(sftp.files.has('/var/log/syslog'), false)
  assert.ok(sftp.files.has('/var/log/syslog.1'))
  browser.dispose()
})

test('a download larger than the ceiling is refused before the stream starts', async () => {
  const { browser } = makeBrowser({ maxDownloadBytes: 1024 })
  const response = new PassThrough()
  let opened = false
  response.writeHead = () => { opened = true }
  await assert.rejects(() => browser.download('web-01', '/var/log/syslog', response), (error) => {
    assert.equal(error.code, 'TOO_LARGE')
    assert.match(error.message, /over the 1024 byte limit/)
    return true
  })
  assert.equal(opened, false, 'no headers were sent for a refused file')
  browser.dispose()
})

test('a download answers with the file and its length', async () => {
  const { browser } = makeBrowser()
  const response = new PassThrough()
  const head = {}
  response.writeHead = (status, headers) => { head.status = status; Object.assign(head, headers) }
  const received = []
  response.on('data', (chunk) => received.push(chunk))
  const finished = new Promise((resolve) => response.on('end', resolve))
  await browser.download('web-01', '/etc/nginx/nginx.conf', response)
  await finished
  assert.equal(head.status, 200)
  assert.equal(head['content-length'], '512')
  assert.match(head['content-disposition'], /nginx\.conf/)
  assert.equal(Buffer.concat(received).toString('utf8'), 'user nginx;\n')
  browser.dispose()
})

test('a download of a directory is refused rather than streamed', async () => {
  const { browser } = makeBrowser()
  const response = new PassThrough()
  response.writeHead = () => {}
  await assert.rejects(() => browser.download('web-01', '/etc', response), /is a directory/)
  browser.dispose()
})

test('an upload writes the body and reports progress', async () => {
  const { browser, sftp } = makeBrowser()
  const request = new PassThrough()
  request.headers = { 'content-length': '11' }
  const response = new PassThrough()
  const head = {}
  response.writeHead = (status, headers) => { head.status = status; Object.assign(head, headers) }
  const lines = []
  response.on('data', (chunk) => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)))

  const pending = browser.upload('web-01', '/var/log/new.log', request, response)
  request.write('hello ')
  request.end('world')
  const result = await pending
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(head.status, 200)
  assert.match(head['content-type'], /ndjson/)
  assert.equal(result.ok, true)
  assert.equal(result.received, 11)
  assert.equal(sftp.files.get('/var/log/new.log').body, 'hello world')
  const frames = lines.map((line) => JSON.parse(line))
  assert.equal(frames.at(-1).type, 'result')
  assert.equal(frames.at(-1).ok, true)
  browser.dispose()
})

test('an upload over the ceiling stops and says so', async () => {
  const { browser, sftp } = makeBrowser({ maxUploadBytes: 1024 })
  const request = new PassThrough()
  request.headers = { 'content-length': '999999' }
  const response = new PassThrough()
  response.writeHead = () => {}
  const lines = []
  response.on('data', (chunk) => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)))

  const pending = browser.upload('web-01', '/var/log/big.bin', request, response)
  request.write(Buffer.alloc(2048, 1))
  const result = await pending

  assert.equal(result.ok, false)
  assert.match(JSON.stringify(result), /over the 1024 byte limit/)
  assert.equal(sftp.files.has('/var/log/big.bin'), false, 'an over-limit upload leaves no file behind')
  browser.dispose()
})

test('the configured ceilings have documented defaults', () => {
  assert.equal(DEFAULT_MAX_DOWNLOAD_BYTES, 256 * 1024 * 1024)
  const { browser } = makeBrowser()
  assert.deepEqual(browser.roots(), ['/'])
  browser.dispose()
})
