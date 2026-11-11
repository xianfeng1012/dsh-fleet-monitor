/**
 * Host discovery tests.
 *
 * The plugin must never carry a host list of its own: every test here builds a
 * throwaway home directory and asserts that discovery reads *that* and nothing
 * else. This is the check that keeps the shipped package free of anyone's real
 * fleet.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { discoverHosts, readSshConfig } from '../lib/hosts.js'

/** Temp roots created by this file. */
const roots = []

/** Make a fresh temp directory that is cleaned up at the end. */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sm-hosts-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const SSH_CONFIG = `# personal hosts
Host web-01
  HostName 10.0.0.11
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host db-01
  HostName db.internal.example
  User postgres

Host *.example.com
  User wildcard-user

Host staging
  HostName staging.example.com
  User deploy # inline comment, quote-aware stripping

Match host bastion exec "/usr/bin/true"
  User ops
`

test('readSshConfig reads literal Host blocks and skips wildcards and Match', () => {
  const root = tempRoot()
  const sshDir = join(root, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  writeFileSync(join(sshDir, 'config'), SSH_CONFIG)

  const problems = []
  const hosts = readSshConfig(sshDir, problems)
  const byAlias = Object.fromEntries(hosts.map((host) => [host.alias, host]))

  assert.equal(hosts.length, 3, 'three literal blocks are pollable')
  assert.equal(byAlias['web-01'].host, '10.0.0.11')
  assert.equal(byAlias['web-01'].port, 2222)
  assert.equal(byAlias['web-01'].user, 'deploy')
  assert.equal(byAlias['web-01'].auth.kind, 'key')
  assert.ok(byAlias['web-01'].auth.keyPath.endsWith('id_ed25519'))
  assert.ok(!byAlias['web-01'].auth.keyPath.startsWith('~'), 'the tilde is expanded')

  assert.equal(byAlias['db-01'].port, 22, 'port defaults to 22')
  assert.equal(byAlias['db-01'].auth.kind, 'agent', 'no IdentityFile means agent auth')
  assert.equal(byAlias['staging'].user, 'deploy', 'the trailing comment was stripped')

  assert.equal(byAlias['*.example.com'], undefined, 'a wildcard block is never polled')
  assert.ok(problems.some((line) => line.includes('*.example.com')))
  assert.ok(problems.some((line) => line.includes('Match')))
})

test('discoverHosts merges sources and dedupes by address', () => {
  const root = tempRoot()
  const sshDir = join(root, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  writeFileSync(join(sshDir, 'config'), SSH_CONFIG)
  writeFileSync(join(root, 'dsh-ssh.json'), JSON.stringify({
    version: 1,
    hosts: [
      // Same destination as ssh-config's web-01, different alias: one node.
      { alias: 'termius-web', host: '10.0.0.11', port: 2222, user: 'deploy', auth: { kind: 'key', keyPath: '/keys/id_rsa' }, tags: ['termius', 'verified'] },
      { alias: 'only-in-dsh-ssh', host: '10.0.0.99', port: 22, user: 'root', auth: { kind: 'password', password: 'x' }, tags: ['termius'] },
    ],
  }))

  const { hosts, problems } = discoverHosts({ dshHome: root, sshDir, manual: [] })
  const byAddress = new Map(hosts.map((host) => [`${host.user}@${host.host}:${host.port}`, host]))

  assert.equal(hosts.length, 4, '3 from ssh-config + 2 from dsh-ssh, minus 1 duplicate')
  // dsh-ssh outranks ssh-config for the same destination, and the tags merge.
  const merged = byAddress.get('deploy@10.0.0.11:2222')
  assert.equal(merged.source, 'dsh-ssh')
  assert.equal(merged.alias, 'termius-web')
  assert.ok(merged.tags.includes('verified'))
  assert.ok(merged.tags.includes('ssh-config'), 'the lower-priority tag is preserved')
  assert.equal(byAddress.get('root@10.0.0.99:22').auth.kind, 'password')
  // The only problems are the knowingly-unpollable ssh-config blocks inherited
  // from the fixture, never an unreadable store.
  assert.equal(problems.filter((line) => line.includes('unreadable')).length, 0)
})

test('manual hosts outrank every discovered source', () => {
  const root = tempRoot()
  const manual = [{ alias: 'pinned', host: '10.0.0.11', port: 2222, user: 'deploy', auth: { kind: 'agent' }, description: 'operator pin' }]
  writeFileSync(join(root, 'dsh-ssh.json'), JSON.stringify({
    hosts: [{ alias: 'from-store', host: '10.0.0.11', port: 2222, user: 'deploy', auth: { kind: 'agent' }, tags: ['termius'] }],
  }))
  const { hosts } = discoverHosts({ dshHome: root, sshDir: join(root, '.ssh'), manual })
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].source, 'manual')
  assert.equal(hosts[0].alias, 'pinned')
  assert.equal(hosts[0].description, 'operator pin')
})

test('a corrupt dsh-ssh.json is reported, not thrown', () => {
  const root = tempRoot()
  writeFileSync(join(root, 'dsh-ssh.json'), '{ not json')
  const { hosts, problems } = discoverHosts({ dshHome: root, sshDir: join(root, '.ssh'), manual: [] })
  assert.equal(hosts.length, 0)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /dsh-ssh\.json unreadable/)
})

test('an empty home directory discovers nothing and does not throw', () => {
  const root = tempRoot()
  const { hosts, problems } = discoverHosts({ dshHome: root, sshDir: join(root, '.ssh'), manual: [] })
  assert.deepEqual(hosts, [])
  assert.deepEqual(problems, [])
})
