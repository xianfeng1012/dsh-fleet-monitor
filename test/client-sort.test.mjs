/**
 * Sorting the servers table: the state machine, the comparator, the header wiring.
 *
 * The bundle has no test renderer, so this file does what `client.test.mjs` does
 * for the page: load the script the way the host does, then call the exported test
 * seam. Text assertions alone cannot tell a working toggle from a header that
 * renders an arrow and sorts nothing, and "the arrow is there but nothing moves"
 * is exactly the failure this feature could ship with.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

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
  location: { hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
}

await import('../lib/client.js')

const entry = registrations[0]

const TESTING = entry.factory((name) => {
  if (name === 'react') return REACT_STUB
  throw new Error(`the client bundle required an unexpected module: ${name}`)
}).__testing

const {
  HOST_COLUMNS,
  SORTABLE_COLUMNS,
  SORT_SPEC,
  ORDER_STORAGE_KEY,
  SortHeader,
  nextOrder,
  sortNodes,
  readStoredOrder,
  storeOrder,
} = TESTING

/**
 * One host entry, shaped like the snapshot's nodes.
 * @param overrides - fields to replace.
 */
function host(overrides) {
  return {
    alias: 'h',
    host: '192.0.2.1',
    port: 22,
    source: 'panel',
    status: 'online',
    cpuPct: 10,
    mem: { pct: 20 },
    disk: { pct: 30 },
    net: { rxBps: 100, txBps: 50 },
    load: [0.5, 0.4, 0.3],
    latencyMs: 20,
    uptimeSec: 3600,
    alerts: [],
    ...overrides,
  }
}

/** The aliases of a sorted list, in order. */
function aliases(list) {
  return list.map((node) => node.alias)
}

/**
 * Flatten an element tree built by the React stub, invoking function components
 * the way React would.
 */
function walkTree(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) walkTree(item, out)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') return walkTree(node.type(node.props), out)
    out.push(node)
    for (const child of node.children ?? []) walkTree(child, out)
  }
  return out
}

test('the comparator covers exactly the sortable columns', () => {
  assert.deepEqual(
    SORTABLE_COLUMNS,
    HOST_COLUMNS.filter((column) => column !== 'actions'),
    'the toolbar and the header offer the same columns',
  )
  assert.deepEqual(
    Object.keys(SORT_SPEC).sort(),
    [...SORTABLE_COLUMNS].sort(),
    'every offered column has a reader and no column is read twice',
  )
  assert.ok(!SORTABLE_COLUMNS.includes('actions'), 'the actions column has nothing to sort by')
})

test('status sorts online first, and the second click puts offline on top', () => {
  const nodes = [
    host({ alias: 'c', status: 'offline' }),
    host({ alias: 'a', status: 'online' }),
    host({ alias: 'b', status: 'skipped' }),
  ]
  assert.deepEqual(aliases(sortNodes(nodes, { key: 'status', dir: 'asc' })), ['a', 'b', 'c'])
  assert.deepEqual(aliases(sortNodes(nodes, { key: 'status', dir: 'desc' })), ['c', 'b', 'a'])
})

test('a status the panel does not know never outranks a real one', () => {
  // `status.unknown` is in the dictionary, so a future collector could emit it.
  // Descending has to put the hosts that need attention on top, not a stranger.
  const nodes = [
    host({ alias: 'z', status: 'unknown' }),
    host({ alias: 'b', status: 'offline' }),
    host({ alias: 'c', status: 'online' }),
  ]
  const descending = sortNodes(nodes, { key: 'status', dir: 'desc' })
  assert.equal(descending[0].status, 'offline', 'offline is first when descending')
  assert.equal(descending[descending.length - 1].status, 'online', 'online is last when descending')
  assert.equal(sortNodes(nodes, { key: 'status', dir: 'asc' })[0].status, 'online')
})

test('a host with no reading sinks, whichever direction is applied', () => {
  const nodes = [
    host({ alias: 'a', cpuPct: 5 }),
    host({ alias: 'b', cpuPct: null }),
    host({ alias: 'c', cpuPct: 90 }),
    host({ alias: 'd', cpuPct: Number.NaN }),
    host({ alias: 'e', cpuPct: undefined }),
  ]
  assert.deepEqual(
    aliases(sortNodes(nodes, { key: 'cpu', dir: 'desc' })),
    ['c', 'a', 'b', 'd', 'e'],
    'busiest first, unknown last',
  )
  assert.deepEqual(
    aliases(sortNodes(nodes, { key: 'cpu', dir: 'asc' })),
    ['a', 'c', 'b', 'd', 'e'],
    'quietest first, unknown still last',
  )
})

test('the network column sorts by the rate the cell actually shows', () => {
  // The cell renders `rxBps` only. Sorting by rx+tx would produce an order the
  // reader cannot verify against the numbers on screen.
  const nodes = [
    host({ alias: 'a', net: { rxBps: 10, txBps: 999999 } }),
    host({ alias: 'b', net: { rxBps: 50, txBps: 1 } }),
  ]
  assert.deepEqual(aliases(sortNodes(nodes, { key: 'net', dir: 'desc' })), ['b', 'a'])
})

test('the alias column sorts by the name on screen and sinks an empty one', () => {
  const nodes = [
    host({ alias: 'bbb' }),
    host({ alias: 'zzz', displayName: 'aaa' }),
    host({ alias: 'mmm', displayName: '' }),
  ]
  assert.deepEqual(
    aliases(sortNodes(nodes, { key: 'alias', dir: 'asc' })),
    ['zzz', 'bbb', 'mmm'],
    'the display name wins, and an empty name is absent data, not a blank first row',
  )
})

test('latency reads low first and uptime reads long first', () => {
  const nodes = [
    host({ alias: 'a', latencyMs: 40, uptimeSec: 10 }),
    host({ alias: 'b', latencyMs: 5, uptimeSec: 900 }),
  ]
  assert.deepEqual(aliases(sortNodes(nodes, { key: 'latency', dir: 'asc' })), ['b', 'a'])
  assert.deepEqual(aliases(sortNodes(nodes, { key: 'uptime', dir: 'desc' })), ['b', 'a'])
  assert.equal(SORT_SPEC.cpu.first, 'desc', 'cpu opens on the busiest host')
  assert.equal(SORT_SPEC.latency.first, 'asc', 'latency opens on the fastest host')
})

test('equal values fall back to the alias, and the input list is left alone', () => {
  const nodes = [
    host({ alias: 'c', cpuPct: 50 }),
    host({ alias: 'a', cpuPct: 50 }),
    host({ alias: 'b', cpuPct: 50 }),
  ]
  const before = aliases(nodes)
  const sorted = sortNodes(nodes, { key: 'cpu', dir: 'desc' })
  assert.deepEqual(aliases(sorted), ['a', 'b', 'c'], 'ties are ordered so a refresh cannot reshuffle them')
  assert.deepEqual(aliases(nodes), before, 'the snapshot array is not reordered in place')
  assert.notEqual(sorted, nodes, 'a new array comes back')
})

test('an order naming a column that no longer exists falls back to the alias', () => {
  // Stored state from an older build can name a column this one does not have. The
  // list still has to come out in a stated order rather than in arrival order.
  const nodes = [host({ alias: 'b' }), host({ alias: 'a' })]
  assert.deepEqual(aliases(sortNodes(nodes, { key: 'expiry', dir: 'asc' })), ['a', 'b'])
  assert.deepEqual(aliases(sortNodes(nodes, { key: 'expiry', dir: 'desc' })), ['b', 'a'])
  assert.deepEqual(aliases(sortNodes(nodes, { key: undefined, dir: 'asc' })), ['a', 'b'])
})

test('one click per column, the same click reverses, two clicks return', () => {
  assert.deepEqual(nextOrder({ key: 'alias', dir: 'asc' }, 'cpu'), { key: 'cpu', dir: 'desc' })
  assert.deepEqual(nextOrder({ key: 'cpu', dir: 'desc' }, 'cpu'), { key: 'cpu', dir: 'asc' })
  assert.deepEqual(nextOrder({ key: 'cpu', dir: 'asc' }, 'latency'), { key: 'latency', dir: 'asc' })

  const first = nextOrder({ key: 'alias', dir: 'asc' }, 'status')
  assert.deepEqual(first, { key: 'status', dir: 'asc' }, 'online first on the first click')
  const second = nextOrder(first, 'status')
  assert.deepEqual(second, { key: 'status', dir: 'desc' }, 'offline first on the second')
  assert.deepEqual(nextOrder(second, 'status'), first, 'the third click comes back')
})

test('an active header announces its direction and hands its column to the click', () => {
  const clicks = []
  const tree = walkTree(SortHeader({
    column: 'cpu',
    order: { key: 'cpu', dir: 'desc' },
    onSort: (key) => clicks.push(key),
  }))
  const [th] = tree.filter((node) => node.type === 'th')
  assert.equal(th.props.scope, 'col')
  assert.equal(th.props.className, 'fm-th on')
  assert.equal(th.props['aria-sort'], 'descending')

  const [button] = tree.filter((node) => node.type === 'button')
  assert.equal(button.props.type, 'button', 'Enter and Space need a real button')
  assert.equal(button.props['data-sort'], 'cpu')
  assert.equal(button.props.title, '点击排序，再次点击反向', 'the fallback dictionary explains the click')

  button.props.onClick()
  assert.deepEqual(clicks, ['cpu'])
})

test('an inactive header says "none" and keeps the neutral arrow', () => {
  const tree = walkTree(SortHeader({
    column: 'mem',
    order: { key: 'cpu', dir: 'asc' },
    onSort: () => {},
  }))
  const [th] = tree.filter((node) => node.type === 'th')
  assert.equal(th.props['aria-sort'], 'none')
  assert.equal(th.props.className, 'fm-th')

  const [arrow] = tree.filter((node) => node.props?.className === 'fm-th-arrow')
  assert.equal(arrow.children[0], '↕', 'the neutral arrow says "this is clickable"')
  assert.equal(arrow.props['aria-hidden'], 'true', 'it is decoration, not content')
})

test('the table header is built from the shared column list', () => {
  assert.ok(
    SOURCE.includes('HOST_COLUMNS.map((column) => ('),
    'the header iterates the shared list',
  )
  assert.ok(SOURCE.includes('h(SortHeader, {'), 'sortable headers are the component')
  assert.equal(
    SOURCE.split("column === 'actions'").length - 1,
    1,
    'the actions column is the one explicit exception',
  )
  assert.doesNotMatch(
    SOURCE,
    /\['alias', 'status', 'os', 'cpu', 'mem', 'disk', 'net', 'load', 'latency', 'uptime', 'actions'\]/,
    'the column list exists once, not twice',
  )
})

test('every sorting string exists in both dictionaries', () => {
  // A missing key does not fail loudly: `translate` falls back to the raw key, so
  // an English reader would see the literal text "sort.hint" in the header.
  const zhBlock = SOURCE.slice(SOURCE.indexOf('const zh = {'), SOURCE.indexOf('const en = {'))
  const enBlock = SOURCE.slice(SOURCE.indexOf('const en = {'), SOURCE.indexOf('let translate'))
  assert.ok(zhBlock.length > 0, 'the zh dictionary is in the bundle')
  assert.ok(enBlock.length > 0, 'the en dictionary is in the bundle')

  for (const key of [...SORTABLE_COLUMNS.map((column) => `sort.${column}`), 'sort.hint', 'sort.asc', 'sort.desc', 'empty.clear']) {
    assert.ok(zhBlock.includes(`'${key}'`), `zh has ${key}`)
    assert.ok(enBlock.includes(`'${key}'`), `en has ${key}`)
  }
})

test('a stored order comes back, and anything unreadable falls back to the alias', () => {
  const original = globalThis.localStorage
  const stored = new Map()
  globalThis.localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)) },
  }
  try {
    assert.deepEqual(readStoredOrder(), { key: 'alias', dir: 'asc' }, 'nothing written yet')

    storeOrder({ key: 'cpu', dir: 'desc' })
    assert.deepEqual(readStoredOrder(), { key: 'cpu', dir: 'desc' }, 'round trip')

    const write = (value) => globalThis.localStorage.setItem(ORDER_STORAGE_KEY, value)
    write('{ not json')
    assert.deepEqual(readStoredOrder(), { key: 'alias', dir: 'asc' }, 'broken json')
    write('null')
    assert.deepEqual(readStoredOrder(), { key: 'alias', dir: 'asc' }, 'json null')
    write(JSON.stringify({ key: 'actions', dir: 'desc' }))
    assert.deepEqual(readStoredOrder(), { key: 'alias', dir: 'asc' }, 'a column that cannot sort')
    write(JSON.stringify({ key: 'cpu', dir: 'sideways' }))
    assert.deepEqual(readStoredOrder(), { key: 'alias', dir: 'asc' }, 'an unknown direction')
    write(JSON.stringify({ key: 'net', dir: 'desc' }))
    assert.deepEqual(readStoredOrder(), { key: 'net', dir: 'desc' }, 'a valid order survives')
  } finally {
    if (original === undefined) delete globalThis.localStorage
    else globalThis.localStorage = original
  }
})

test('a blocked storage does not stop the panel from sorting', () => {
  const original = globalThis.localStorage
  globalThis.localStorage = {
    getItem() { throw new Error('storage disabled') },
    setItem() { throw new Error('storage disabled') },
  }
  try {
    assert.deepEqual(readStoredOrder(), { key: 'alias', dir: 'asc' })
    assert.doesNotThrow(() => storeOrder({ key: 'mem', dir: 'asc' }))
  } finally {
    if (original === undefined) delete globalThis.localStorage
    else globalThis.localStorage = original
  }
})
