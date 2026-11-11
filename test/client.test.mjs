/**
 * Client-half tests: load the browser bundle the way the harness does and mount it
 * against a fake slot/locale context.
 *
 * The browser half is a plain script, not a module — it registers a factory with
 * `window.__ModuleLoader__` and pulls React out of the host. Nothing here renders a
 * component; what is being checked is that the script survives being loaded and that
 * a host which refuses one of the client services still ends up with a working panel.
 * A load-time throw is invisible until someone reloads the GUI, which is exactly the
 * failure mode worth pinning down in a test.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

/** A React stand-in: the bundle only reads these off the object at load time. */
const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}

/** Captures what the bundle registers with `window.__ModuleLoader__`. */
const registrations = []

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registrations.push(entry)
    },
  },
  // The page reads its active section out of the hash on every render, and the
  // section hook subscribes to `hashchange`. Both have to exist before the component
  // runs, even though this test never navigates.
  location: { hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
}

// Setting the global has to happen before the bundle runs, so this import is dynamic.
await import('../lib/client.js')

/** The single registration the bundle performed. */
const entry = registrations[0]

/**
 * Run the captured factory with a stubbed `require`.
 * @returns the module exports the host would receive.
 */
function loadExports() {
  return entry.factory((name) => {
    if (name === 'react') return REACT_STUB
    throw new Error(`the client bundle required an unexpected module: ${name}`)
  })
}

test('the bundle registers one factory under a stable id', () => {
  assert.equal(registrations.length, 1, 'the script registers exactly one factory')
  assert.equal(entry.id, 'dsh-fleet-monitor')
  assert.equal(typeof entry.factory, 'function')
})

test('the factory needs nothing from the host except react', () => {
  const exports = loadExports()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

/**
 * Build a client context that records every registration.
 * @param overrides - services to replace; pass `null` to model a host without them.
 */
function fakeClientContext(overrides = {}) {
  const record = { locale: null, slots: [], effects: [], disposed: [] }
  const ctx = {
    effect(run, label) {
      const inner = run()
      record.effects.push({ label, dispose: typeof inner === 'function' ? inner : () => {} })
      return inner
    },
    locale: {
      register(namespace, dictionaries) {
        record.locale = { namespace, dictionaries }
        return () => { record.disposed.push('locale') }
      },
      bind() {
        return () => 'translated'
      },
    },
    slots: {
      inject(name, factory) {
        const dispose = factory()
        record.slots.push({ name, dispose })
        return () => { record.disposed.push(`inject:${name}`) }
      },
      register(spec, component) {
        record.slots.push({ registered: spec, component })
        return () => { record.disposed.push(`register:${spec.name}`) }
      },
    },
    ...overrides,
  }
  return { ctx, record }
}

/** Unload everything the plugin registered. */
function unmount(record) {
  for (const effect of [...record.effects].reverse()) effect.dispose()
}

test('apply registers both dictionaries and both slots', () => {
  const exports = loadExports()
  const { ctx, record } = fakeClientContext()
  exports.apply(ctx)
  try {
    assert.equal(record.locale.namespace, 'dsh-fleet-monitor')
    assert.equal(record.locale.dictionaries.zh['entry.label'], '机群监控')
    assert.equal(typeof record.locale.dictionaries.en['entry.label'], 'string')

    const registered = record.slots.filter((slot) => slot.registered !== undefined)
    assert.equal(registered.length, 2, 'a sidebar entry and a page')
    const sidebar = registered.find((slot) => slot.registered.name === 'sidebar.panellist')
    const main = registered.find((slot) => slot.registered.name === 'main')
    assert.equal(sidebar.registered.id, 'fleet-monitor')
    assert.equal(sidebar.registered.order, 50, 'after SSH (40)')
    assert.equal(typeof sidebar.component, 'function', 'the entry needs an icon component')
    assert.equal(main.registered.key, 'fleet-monitor')
    assert.equal(typeof main.component, 'function', 'the page must be a component')
  } finally {
    unmount(record)
  }
})

test('the sidebar entry is asked for its label lazily', () => {
  const exports = loadExports()
  const { ctx, record } = fakeClientContext()
  exports.apply(ctx)
  try {
    const sidebar = record.slots.find((slot) => slot.registered?.name === 'sidebar.panellist')
    // The host calls this on every render; it must resolve through the bound locale.
    assert.equal(sidebar.registered.label(), 'translated')
  } finally {
    unmount(record)
  }
})

test('unloading releases the slots and the dictionaries', () => {
  const exports = loadExports()
  const { ctx, record } = fakeClientContext()
  exports.apply(ctx)
  unmount(record)
  assert.ok(record.disposed.includes('locale'), 'the dictionary registration is released')
  // The bundle disposes the injection points, which is the same contract the shipped
  // SSH panel relies on: the host owns whatever a point's factory registered and
  // tears it down with the point itself.
  assert.ok(record.disposed.includes('inject:sidebar.panellist'))
  assert.ok(record.disposed.includes('inject:main'))
})

test('a locale service that refuses registration still leaves a panel', () => {
  const exports = loadExports()
  const { ctx, record } = fakeClientContext({
    locale: {
      register() { throw new Error('locale busy') },
      bind() { throw new Error('locale busy') },
    },
  })
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  exports.apply(ctx)
  try {
    assert.equal(
      record.slots.filter((slot) => slot.registered !== undefined).length,
      2,
      'both slots are still registered',
    )
  } finally {
    console.warn = original
    unmount(record)
  }
})

test('a missing slot service is reported, not thrown', () => {
  const exports = loadExports()
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  const ctx = {
    effect(run) {
      const inner = run()
      return inner
    },
    locale: { register: () => () => {}, bind: () => () => 'x' },
    slots: {
      inject() { throw new Error('slots unavailable') },
      register() { throw new Error('slots unavailable') },
    },
  }
  try {
    exports.apply(ctx)
    assert.ok(
      warnings.some((line) => line.includes('panel registration failed')),
      'the failure is surfaced in the console',
    )
  } finally {
    console.warn = original
  }
})

/**
 * Flatten an element tree built by the React stub.
 *
 * Function components are invoked, because React would: a test that stops at the
 * component boundary can only see the outer shell, and the shell is exactly the part
 * that never breaks.
 */
function walk(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') return walk(node.type(node.props), out)
    out.push(node)
    for (const child of node.children ?? []) walk(child, out)
  }
  return out
}

/**
 * Render the page component once through the stub.
 *
 * The stub's hooks return their initial value and its effects never run, so this is a
 * single static render: enough to prove the component body executes without a live
 * host, without a network, and without DOM globals beyond the ones above.
 */
function renderPage(hash = '') {
  const exports = loadExports()
  const { ctx, record } = fakeClientContext()
  exports.apply(ctx)
  const previous = globalThis.window.location.hash
  globalThis.window.location.hash = hash
  try {
    const main = record.slots.find((slot) => slot.registered?.name === 'main')
    return walk(main.component())
  } finally {
    globalThis.window.location.hash = previous
    unmount(record)
  }
}

test('the page renders one navigation tab per section and lands on the overview', () => {
  const rendered = renderPage()
  const tabs = rendered.filter((node) => /^fm-tab(\s|$)/.test(String(node.props?.className ?? '')))
  assert.equal(tabs.length, 6, 'one tab per section')
  assert.equal(
    tabs.filter((node) => String(node.props.className).includes(' on')).length,
    1,
    'exactly one tab is active',
  )
  assert.equal(
    tabs[0].props.className.includes(' on'),
    true,
    'the first tab (overview) is the default view',
  )
})

test('the host table only appears in the servers section', () => {
  const rendered = renderPage()
  // With `window.location.hash` empty the page starts on the overview, so the table
  // and the filter toolbar must both be absent.
  assert.equal(
    rendered.filter((node) => node.type === 'table').length,
    0,
    'no table on the overview',
  )
  assert.equal(
    rendered.filter((node) => String(node.props?.className ?? '') === 'fm-toolbar').length,
    0,
    'no filter toolbar on the overview',
  )
})

test('the overview still shows the fleet counters', () => {
  const rendered = renderPage()
  const stats = rendered.filter((node) => String(node.props?.className ?? '') === 'fm-stat')
  assert.equal(stats.length, 4, 'total, online, alerting, offline')
})

test('the services section renders its own panel, not the pending placeholder', () => {
  // The stub locale answers every key with "translated", so text cannot tell the two
  // views apart. The section wrappers can: only the wired-up sections use `fm-panel`.
  const panels = (hash) => renderPage(hash)
    .filter(node => String(node.props?.className ?? '') === 'fm-panel')
  assert.equal(panels('#/services').length, 1, 'services renders a real panel')
  assert.equal(panels('#/alerts').length, 1, 'alerts renders a real panel')
  assert.equal(panels('#/tasks').length, 1, 'tasks has its own panel now')
})