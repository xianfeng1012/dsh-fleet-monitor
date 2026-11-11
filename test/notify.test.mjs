/** Notification templates: substitution, request building, and real delivery. */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import {
  PLACEHOLDER_NAMES,
  PRESETS,
  buildRequest,
  renderTemplate,
  sendToChannel,
  sendToChannels,
} from '../lib/notify.js'

/** A node as the collector shapes it, with every field a placeholder reads. */
const NODE = {
  alias: 'web-01',
  name: '上海生产-01',
  host: '10.0.0.11',
  group: '生产',
  cpuPct: 91.44,
  mem: { usedBytes: 3 * 1024 ** 3, totalBytes: 4 * 1024 ** 3 },
  disk: { usedBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
}

const RULE = { name: 'CPU 高', metric: 'cpu', threshold: 85, durationSec: 180 }
const CONTEXT = { node: NODE, rule: RULE, value: 91.44, state: 'firing', message: '90 秒超过阈值' }

test('every placeholder resolves, and none of them leak the token itself', () => {
  const template = PLACEHOLDER_NAMES.join(' ')
  const rendered = renderTemplate(template, CONTEXT)
  for (const token of PLACEHOLDER_NAMES) {
    assert.ok(!rendered.includes(token), `${token} was substituted`)
  }
  assert.ok(rendered.includes('上海生产-01'))
  assert.ok(rendered.includes('10.0.0.11'))
  assert.ok(rendered.includes('91%'), 'cpu is rounded, not printed with decimals')
  assert.ok(rendered.includes('75%'), 'memory is used over total')
  assert.ok(rendered.includes('50%'), 'disk is used over total')
  assert.ok(rendered.includes('触发'))
})

test('a placeholder the engine does not own survives the render', () => {
  // A typo should be visible in the delivered message, not silently blanked.
  assert.equal(renderTemplate('#SERVER.NMAE#', CONTEXT), '#SERVER.NMAE#')
  assert.equal(renderTemplate('', CONTEXT), '')
  assert.equal(renderTemplate(null, CONTEXT), '')
})

test('a missing total reads as n/a rather than zero percent', () => {
  const rendered = renderTemplate('#SERVER.MEM# #SERVER.DISK#', {
    node: { ...NODE, mem: { usedBytes: 10, totalBytes: 0 }, disk: undefined },
    rule: RULE,
    value: null,
    state: 'resolved',
    message: '',
  })
  assert.equal(rendered, 'n/a n/a')
})

test('a json body sends the json content type and substitutes headers too', () => {
  const built = buildRequest(
    { url: 'https://example.com/#SERVER.ALIAS#', method: 'post', bodyType: 'json', headers: '{"x-rule":"#RULE.METRIC#"}', body: '{"v":"#VALUE#"}' },
    CONTEXT,
  )
  assert.equal(built.url.toString(), 'https://example.com/web-01')
  assert.equal(built.method, 'POST')
  assert.equal(built.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(built.headers['x-rule'], 'cpu')
  assert.equal(built.body, '{"v":"91.44"}')
})

test('a form body sends the form content type', () => {
  const built = buildRequest(
    { url: 'https://example.com/hook', method: 'POST', bodyType: 'form', headers: '{}', body: 'k=#VALUE#' },
    CONTEXT,
  )
  assert.equal(built.headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8')
})

test('a GET drops the body instead of asking fetch to reject it', () => {
  const built = buildRequest({ url: 'https://example.com/#VALUE#', method: 'GET', bodyType: 'json', headers: '{}', body: '{"a":1}' }, CONTEXT)
  assert.equal(built.body, null)
  assert.equal(built.url.toString(), 'https://example.com/91.44')
})

test('malformed header json still lets the body through', () => {
  const built = buildRequest({ url: 'https://example.com', method: 'POST', bodyType: 'json', headers: '{not json', body: '{"a":"#VALUE#"}' }, CONTEXT)
  assert.deepEqual(built.headers, { 'content-type': 'application/json; charset=utf-8' })
  assert.equal(built.body, '{"a":"91.44"}')
})

test('a 2xx delivery is a success and a 5xx is a recorded failure', async (t) => {
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      seen.push({ url: request.url, method: request.method, headers: request.headers, body })
      response.writeHead(request.url === '/bad' ? 500 : 200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

  const good = await sendToChannel(
    { url: `${base}/good`, method: 'POST', bodyType: 'json', headers: '{"x-alias":"#SERVER.ALIAS#"}', body: '{"state":"#STATE#"}' },
    CONTEXT,
  )
  assert.deepEqual(good, { ok: true, status: 200, error: null })

  const bad = await sendToChannel({ url: `${base}/bad`, method: 'POST', bodyType: 'json', headers: '{}', body: '{}' }, CONTEXT)
  assert.equal(bad.ok, false)
  assert.equal(bad.status, 500)
  assert.equal(bad.error, 'HTTP 500')

  assert.equal(seen.length, 2)
  assert.equal(seen[0].headers['x-alias'], 'web-01')
  assert.equal(seen[0].body, '{"state":"触发"}')
})

test('an unreachable endpoint is a failure, not a throw', async () => {
  const result = await sendToChannel({ url: 'http://127.0.0.1:1/hook', method: 'POST', bodyType: 'json', headers: '{}', body: '{}' }, CONTEXT)
  assert.equal(result.ok, false)
  assert.equal(result.status, null)
  assert.ok(typeof result.error === 'string' && result.error !== '')
})

test('a channel with an unparsable url is reported, not thrown', async () => {
  const result = await sendToChannel({ url: 'not a url', method: 'POST', bodyType: 'json', headers: '{}', body: '{}' }, CONTEXT)
  assert.equal(result.ok, false)
  assert.ok(typeof result.error === 'string')
})

test('sending to a group counts the failures instead of stopping at the first', async () => {
  const server = createServer((request, response) => { response.writeHead(200); response.end('ok') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const summary = await sendToChannels(
      [
        { url: `http://127.0.0.1:${port}/a`, method: 'POST', bodyType: 'json', headers: '{}', body: '{}' },
        { url: 'http://127.0.0.1:1/b', method: 'POST', bodyType: 'json', headers: '{}', body: '{}' },
        { url: `http://127.0.0.1:${port}/c`, method: 'POST', bodyType: 'json', headers: '{}', body: '{}' },
      ],
      CONTEXT,
    )
    assert.equal(summary.sent, 2)
    assert.equal(summary.failed, 1)
    assert.equal(summary.errors.length, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the four presets are complete templates that keep their secrets as literals', () => {
  assert.deepEqual(PRESETS.map((preset) => preset.id), ['bark', 'telegram', 'lark', 'wecom'])
  for (const preset of PRESETS) {
    assert.ok(/^https:\/\//.test(preset.url), `${preset.id} uses https`)
    assert.ok(preset.body.includes('#'), `${preset.id} body has placeholders`)
    assert.ok(/\{[a-z]+\}/.test(preset.url), `${preset.id} leaves its credential as a {placeholder}`)
    assert.equal(preset.bodyType, 'json')
  }
})
