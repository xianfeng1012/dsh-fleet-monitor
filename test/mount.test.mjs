/**
 * Mount tests: the host half, driven against a fake cordis context.
 *
 * Every surface this plugin adds to the host process is registered through
 * `ctx.effect` with a disposer, and the host can unload the plugin at any time.
 * A surface registered outside `ctx.effect` would survive that unload and either
 * throw on the next request or keep an interval alive forever, so the shape of
 * these registrations is a correctness property, not a style choice.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import * as host from '../lib/index.js'

/** Temp roots created by this file. */
const roots = []

/** Make a fresh temp directory that is cleaned up at the end. */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sm-mount-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/**
 * Build a context that records every registration and can unload them all.
 * @returns the context plus the record of what it received.
 */
function fakeContext() {
  const record = { routes: [], tools: [], sections: [], effects: [], listeners: [], disposed: 0 }
  const disposer = (bucket) => () => {
    record.disposed += 1
    const index = bucket.findIndex((item) => item.disposed === false)
    if (index !== -1) bucket[index].disposed = true
  }
  const ctx = {
    effect(run, label) {
      assert.equal(typeof run, 'function', 'ctx.effect takes a factory')
      assert.equal(typeof label, 'string', 'every effect is labelled for the host log')
      const inner = run()
      record.effects.push({ label, dispose: typeof inner === 'function' ? inner : () => {} })
      return inner
    },
    on(event, handler) {
      record.listeners.push({ event, handler })
      return () => {}
    },
    webServer: {
      register(route) {
        assert.equal(typeof route.path, 'string')
        assert.equal(typeof route.handler, 'function')
        const entry = { route, disposed: false }
        record.routes.push(entry)
        return () => {
          entry.disposed = true
          record.disposed += 1
        }
      },
    },
    tools: {
      register(tool) {
        const entry = { tool, disposed: false }
        record.tools.push(entry)
        return () => {
          entry.disposed = true
          record.disposed += 1
        }
      },
    },
    systemPrompt: {
      section(section) {
        const entry = { section, disposed: false }
        record.sections.push(entry)
        return () => {
          entry.disposed = true
          record.disposed += 1
        }
      },
    },
  }
  return { ctx, record }
}

/** Unload everything the plugin registered, newest effect first (host order). */
function unmount(record) {
  for (const effect of [...record.effects].reverse()) effect.dispose()
}

/** A config the plugin accepts, pointed at a throwaway home. */
function fakeConfig(dshHome) {
  return {
    intervalMs: 3_600_000,
    concurrency: 2,
    execTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    dshHome,
    sshDir: join(dshHome, 'no-ssh'),
    agentSocket: '',
    includeTag: '',
    excludeAliases: [],
    hosts: [],
    cpuAlertPct: 85,
    memAlertPct: 90,
    diskAlertPct: 90,
    keep: 100,
    announceToAgent: true,
  }
}

test('the host half declares a name, a string inject list, and a Config', () => {
  assert.equal(host.name, 'dsh-fleet-monitor')
  // The host's loader only understands a plain string array here. An object
  // shape (`{required, optional}`) reads as "no services", so `ctx.webServer`
  // stays undefined and every route silently fails to register.
  assert.ok(Array.isArray(host.inject), 'inject must be an array of service names')
  assert.deepEqual(host.inject, ['webServer', 'tools', 'systemPrompt'])
  assert.equal(typeof host.Config, 'function', 'schemastery schemas are constructor functions')
  assert.equal(typeof host.apply, 'function')
})

test('apply is synchronous 鈥?the host does not await a returned promise', () => {
  const { ctx, record } = fakeContext()
  try {
    const returned = host.apply(ctx, fakeConfig(tempRoot()))
    assert.ok(!(returned instanceof Promise), 'apply returned a promise; a rejection there is swallowed by the loader')
    assert.equal(returned, undefined)
  } finally {
    // The mount-once id is process-global: leaving it held would queue every
    // later test behind this one and register nothing.
    unmount(record)
  }
})

test('a volatile config field is followed through its live reference', () => {
  // The loader does not hand over the value of a `volatile()` field: it hands
  // over a stable `{get()}` reference whose owner writes the new value in
  // place. Reading `config.announceToAgent` directly would compare an object
  // against `false`, decide "not false", and keep the announcement on forever.
  const { ctx, record } = fakeContext()
  try {
    host.apply(ctx, { ...fakeConfig(tempRoot()), announceToAgent: { get: () => false } })
    assert.deepEqual(record.sections, [], 'the reference resolved to false, so no section is announced')
  } finally {
    unmount(record)
  }
})

test('apply registers every surface inside a labelled effect', async () => {
  const dshHome = tempRoot()
  const { ctx, record } = fakeContext()
  await host.apply(ctx, fakeConfig(dshHome))
  try {
    assert.equal(record.routes.length, 7, 'overview, events, history, refresh, status, hosts, test')
    assert.deepEqual(
      record.routes.map((entry) => entry.route.path).sort(),
      [
        '/api/dsh-fleet-monitor/events',
        '/api/dsh-fleet-monitor/history',
        '/api/dsh-fleet-monitor/hosts',
        '/api/dsh-fleet-monitor/overview',
        '/api/dsh-fleet-monitor/refresh',
        '/api/dsh-fleet-monitor/status',
        '/api/dsh-fleet-monitor/test',
      ],
    )

    assert.equal(record.tools.length, 3)
    assert.deepEqual(
      record.tools.map((entry) => entry.tool.name).sort(),
      ['fleet_history', 'fleet_refresh', 'fleet_snapshot'],
    )
    for (const { tool } of record.tools) {
      assert.equal(typeof tool.description, 'string')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.isConcurrencySafe, 'function')
    }
    // Only the read-only tools may overlap with a sibling call; refresh opens real
    // SSH connections and must be serialised.
    const byName = Object.fromEntries(record.tools.map((entry) => [entry.tool.name, entry.tool]))
    assert.equal(byName['fleet_snapshot'].isConcurrencySafe(), true)
    assert.equal(byName['fleet_history'].isConcurrencySafe(), true)
    assert.equal(byName['fleet_refresh'].isConcurrencySafe(), false)

    assert.equal(record.sections.length, 1, 'the agent is told the tools exist')
    assert.equal(record.sections[0].section.order, 620)
    assert.match(record.sections[0].section.text, /fleet_snapshot/)

    // routes + tools + prompt + collector + the mount guard.
    assert.equal(record.effects.length, 5)
    assert.deepEqual(
      record.effects.map((effect) => effect.label).sort(),
      [
        'dsh-fleet-monitor: collector',
        'dsh-fleet-monitor: mount guard',
        'dsh-fleet-monitor: prompt',
        'dsh-fleet-monitor: routes',
        'dsh-fleet-monitor: tools',
      ],
    )

    // The volatile-update listener is how a config edit reaches the running sweep.
    assert.ok(record.listeners.some((listener) => listener.event === 'loader/volatile-update'))
  } finally {
    unmount(record)
  }

  // Unloading must release everything: the host may swap this plugin out at any
  // time and a leaked route, tool or SQLite handle would outlive it.
  assert.equal(record.routes.every((entry) => entry.disposed), true, 'every route is unregistered')
  assert.equal(record.tools.every((entry) => entry.disposed), true, 'every tool is unregistered')
  assert.equal(record.sections.every((entry) => entry.disposed), true, 'the prompt section is removed')
})

test('the guard is released on unload so a reload can mount again', async () => {
  const dshHome = tempRoot()
  const first = fakeContext()
  await host.apply(first.ctx, fakeConfig(dshHome))
  assert.equal(first.record.routes.length, 7)
  unmount(first.record)

  // A reload evaluates the same module again; without a released guard this mount
  // would silently register nothing and the plugin would look enabled but be inert.
  const second = fakeContext()
  await host.apply(second.ctx, fakeConfig(dshHome))
  try {
    assert.equal(second.record.routes.length, 7, 'the reload mounted for real')
  } finally {
    unmount(second.record)
  }
})

test('a concurrent second mount queues instead of double-registering', async () => {
  const dshHome = tempRoot()
  const first = fakeContext()
  await host.apply(first.ctx, fakeConfig(dshHome))
  const second = fakeContext()
  await host.apply(second.ctx, fakeConfig(dshHome))
  try {
    assert.equal(second.record.routes.length, 0, 'the duplicate mount registered nothing')
  } finally {
    // Releasing the first must replay the queued mount.
    unmount(first.record)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(second.record.routes.length, 7, 'the queued mount was replayed')
    unmount(second.record)
  }
})

test('a host without the optional capabilities still mounts', async () => {
  const dshHome = tempRoot()
  const record = { routes: [], sections: [], effects: [] }
  const ctx = {
    effect(run, label) {
      const inner = run()
      record.effects.push({ label, dispose: typeof inner === 'function' ? inner : () => {} })
      return inner
    },
    on() { return () => {} },
    webServer: { register(route) { record.routes.push(route); return () => {} } },
    // tools and systemPrompt are deliberately absent.
  }
  await host.apply(ctx, fakeConfig(dshHome))
  try {
    assert.equal(record.routes.length, 7, 'routes do not depend on the optional services')
    assert.equal(record.sections.length, 0)
    assert.equal(record.effects.length, 3, 'routes, the collector, and the mount guard')
  } finally {
    for (const effect of [...record.effects].reverse()) effect.dispose()
  }
})
