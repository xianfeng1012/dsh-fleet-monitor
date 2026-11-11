/**
 * Source-level checks on the panel's section navigation and the metadata editor.
 *
 * These read the bundle as text rather than rendering it: the browser half has no
 * test renderer, and what matters here is that the wiring exists at all — a tab that
 * navigates nowhere, or a metadata form that quietly posts credentials, is a shape
 * bug that a screenshot will not catch until someone clicks it in production.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { METRIC_NAMES } from '../lib/alerts.js'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** The literal `const SECTIONS = [...]` list, as declared. */
function declaredSections() {
  const match = /const SECTIONS = \[([^\]]*)\]/.exec(SOURCE)
  assert.ok(match !== null, 'the bundle declares its sections')
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item !== '')
}

/**
 * The body of one top-level function inside the factory.
 * @param name - the function name to slice out.
 */
function functionBody(name) {
  const start = SOURCE.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} is declared`)
  const end = SOURCE.indexOf('\n    }\n', start)
  assert.notEqual(end, -1, `${name} is closed at the factory indent`)
  return SOURCE.slice(start, end)
}

test('the panel declares the six expected sections in navigation order', () => {
  assert.deepEqual(
    declaredSections(),
    ['overview', 'servers', 'services', 'alerts', 'tasks', 'settings'],
  )
})

test('every section has a label in both dictionaries', () => {
  const sections = declaredSections()
  // The label is looked up as `nav.<id>`; a missing key would render the raw key
  // into the tab strip, which is worse than an empty tab.
  for (const section of sections) {
    const occurrences = SOURCE.split(`'nav.${section}'`).length - 1
    assert.equal(occurrences, 2, `nav.${section} is translated in zh and en`)
  }
})

test('the active section lives in the URL hash so a reload returns to it', () => {
  const body = functionBody('useSection')
  assert.match(body, /window\.location\.hash/, 'the section is written to the hash')
  assert.match(body, /addEventListener\('hashchange'/, 'a hash change updates the view')
  assert.match(body, /SECTIONS\.includes\(raw\)/, 'an unknown hash falls back instead of breaking')
})

test('the metadata editor never posts a credential', () => {
  const body = functionBody('MetaForm')
  // Metadata is display state. Reaching data belongs to HostForm, and mixing the two
  // would mean an alias rename could silently rewrite the auth of a live host.
  assert.doesNotMatch(body, /password/i)
  assert.doesNotMatch(body, /keyPath/)
  assert.doesNotMatch(body, /passphrase/i)
  assert.match(body, /alias: props\.alias/, 'the join key is passed through unchanged')
})

test('the servers view is the only one that renders the host table', () => {
  // The table, the toolbar and the stats strip are guarded by `section !== 'servers'`.
  // If one of them loses the guard, it bleeds into every other tab.
  const guards = SOURCE.split("section !== 'servers'").length - 1
  assert.ok(guards >= 4, `expected at least four server-only guards, found ${guards}`)
})

test('the service strip is a fixed thirty cells and pads the left', () => {
  // Nezha's `Delay *[30]` is a fixed shape, and the panel pads rather than stretches
  // so a probe started ten minutes ago does not look like it has been up all day.
  assert.match(SOURCE, /for \(let index = 0; index < 30; index \+= 1\)/)
  assert.match(SOURCE, /const offset = 30 - cells\.length/)
  assert.match(SOURCE, /\.fm-grid30 \{ grid-column: 1 \/ -1; display: grid; grid-template-columns: repeat\(30, 1fr\)/)
  assert.match(SOURCE, /\.fm-cell\.ok \{ background: #22c55e/, 'an up cell is green')
  assert.match(SOURCE, /\.fm-cell\.bad \{ background: #ef4444/, 'a failed cell is red')
})

test('the probe editor only sends fields the services route validates', () => {
  const body = functionBody('ProbeForm')
  for (const field of ['name:', 'type:', 'target:', 'intervalSec:', 'timeoutMs:', 'expectStatus:', 'expectKeyword:']) {
    assert.ok(body.includes(field), `ProbeForm sends ${field}`)
  }
  // `enabled` is shorthand at the end of the literal, so the comma after it is the
  // only thing that distinguishes the payload from the checkbox's own `enabled`.
  assert.ok(body.includes('enabled,\n          })'), 'ProbeForm sends enabled')
  assert.ok(!body.includes('password'), 'a probe has no credential to send')
})

test('the rule editor offers exactly the metrics the engine can read', () => {
  // A dropdown entry with no reader looks enabled and never fires - the worst kind
  // of alert bug, because nothing reports it.
  const declared = SOURCE.match(/const METRIC_ORDER = \[([\s\S]*?)\]/)
  assert.ok(declared !== null, 'METRIC_ORDER is declared')
  const offered = [...declared[1].matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1])
  assert.deepEqual([...offered].sort(), [...METRIC_NAMES].sort(), 'the two lists are the same set')
  assert.equal(offered.length, 19)
})

test('the rule editor sends the shape the alerts route validates', () => {
  const body = functionBody('RuleForm')
  for (const field of ['name:', 'metric,', 'op,', 'threshold:', 'durationSec:', 'cooldownSec:', 'notifyGroupId:', 'enabled,', 'scope: {']) {
    assert.ok(body.includes(field), `RuleForm sends ${field}`)
  }
  assert.ok(body.includes("mode === 'all' ? [] :"), 'the alias list is only sent when the scope is not "all"')
})

test('the channel editor never collects a credential the panel cannot show', () => {
  const body = functionBody('ChannelForm')
  for (const field of ['url:', 'method,', 'bodyType,', 'headers,', 'body,', 'verifyTls }']) {
    assert.ok(body.includes(field), `ChannelForm sends ${field}`)
  }
  assert.ok(body.includes('props.presets'), 'the presets come from the server')
  assert.ok(!body.includes('password'), 'a webhook has no password field')
})
test('the overview draws an availability strip and keeps uncollected hours empty', () => {
  const strip = functionBody('UptimeStrip')
  // A null cell means nobody was collecting (before install, after a shutdown).
  // Painting it red would report an outage the plugin never witnessed.
  assert.ok(strip.includes("cell === null ? ' none'"), 'missing data has its own class')
  assert.ok(strip.includes("t('overview.noSamples')"), 'the tooltip names missing data')
  assert.ok(strip.includes('props.currentIndex === index'), 'the hour still filling is marked')

  const overview = functionBody('OverviewSection')
  assert.ok(overview.includes('h(UptimeStrip, { cells: uptime.fleet'), 'the fleet average has its own strip')
  assert.ok(overview.includes('h(UptimeStrip, { cells: node.uptime24'), 'every tracked host gets one')
  assert.ok(overview.includes('uptimeAverage(node.uptime24)'), 'the row percentage ignores empty hours')
  assert.ok(overview.includes('slice(0, 12)'), 'the worst twelve are enough for a first screen')
})
test('the terminal view speaks the frame protocol the host half expects', () => {
  const view = functionBody('TerminalView')
  for (const type of ["'input'", "'close'"]) {
    assert.ok(view.includes(`type: ${type}`), `the view sends ${type} frames`)
  }
  for (const incoming of ["'output'", "'ready'", "'exit'"]) {
    assert.ok(view.includes(`type === ${incoming}`), `the view handles ${incoming} frames`)
  }
  // The socket path and the alias have to match the upgrade route exactly, or the
  // panel opens a terminal nobody is listening for.
  assert.ok(view.includes('API_BASE}/terminal?alias='), 'the socket is opened on the terminal route')
  assert.ok(view.includes('encodeURIComponent(props.alias)'), 'an alias with punctuation still resolves')
})

test('the terminal view says where full-screen programs belong', () => {
  const view = functionBody('TerminalView')
  assert.ok(view.includes("t('terminal.hint')"), 'the hint is rendered, not buried in a comment')
  // A line buffer is not a VT100, and claiming otherwise is the bug this prevents.
  assert.ok(view.includes('pre.scrollTop = pre.scrollHeight'), 'output follows the cursor')
  assert.ok(!view.includes("'Enter'.repeat"), 'keys are sent, not typed into the DOM')
})

test('the file panel calls the five routes the host half registers', () => {
  const panel = functionBody('FilePanel')
  for (const call of ["'/fs/mkdir'", "'/fs/rename'", "'/fs/delete'"]) {
    assert.ok(panel.includes(call), `the panel calls ${call}`)
  }
  // Listing lives in the hook that owns the path, not in the render function.
  assert.ok(functionBody('useFiles').includes('/fs/ls?alias='), 'the listing goes through the ls route')
  // Upload is a raw-body POST, not a form: the route streams the request body
  // straight to SFTP and answers in NDJSON, so the URL carries both parameters.
  const upload = functionBody('uploadFile')
  assert.ok(upload.includes('/fs/upload?alias='), 'the upload carries the alias in the query')
  assert.ok(upload.includes("'content-type': 'application/octet-stream'"), 'the body is the file itself')
  assert.ok(upload.includes("frame.type === 'progress'"), 'progress frames are read as they arrive')
  assert.ok(upload.includes("frame.type === 'result'"), 'the result frame settles the call')
})

test('deleting a folder in the panel asks the route to recurse', () => {
  const panel = functionBody('FilePanel')
  // A directory that is not empty is refused by the route unless `recursive` is
  // set, so the panel has to send what the entry actually is.
  assert.ok(panel.includes('recursive: entry.isDirectory'), 'a folder deletion is sent as recursive')
  assert.ok(panel.includes("t('files.hint')"), 'the panel says deletion has no recycle bin')
})
