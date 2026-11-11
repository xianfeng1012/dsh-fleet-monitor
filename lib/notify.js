/**
 * Notification delivery: one HTTP call per channel, driven by a template.
 *
 * There is no provider enum anywhere in this file, and that is the point. Nezha
 * made the same call: Bark, Telegram, Lark, WeCom, PushPlus, Gotify and Matrix
 * all reduce to "send this body to this URL", so a template plus a settings form
 * covers every one of them, and a provider nobody has written yet costs nothing
 * but a URL. A provider enum would turn each new service into a code change.
 */

import { request as httpsRequest } from 'node:https'

/** How long one channel may take before we stop waiting for it. */
const SEND_TIMEOUT_MS = 10_000

/**
 * Values substituted into a channel's URL, headers and body.
 *
 * Every entry is `(node, rule, value, state, message) => string`, so a template
 * can reference anything the evaluation already knows without the sender having
 * to know which provider it is talking to.
 */
const PLACEHOLDERS = {
  '#SERVER.NAME#': (node) => node.name ?? node.alias,
  '#SERVER.ALIAS#': (node) => node.alias,
  '#SERVER.IP#': (node) => node.host,
  '#SERVER.GROUP#': (node) => node.group ?? '',
  '#SERVER.CPU#': (node) => percent(node.cpuPct),
  '#SERVER.MEM#': (node) => percent(memoryPct(node)),
  '#SERVER.DISK#': (node) => percent(diskPct(node)),
  '#RULE.NAME#': (_node, rule) => rule.name,
  '#RULE.METRIC#': (_node, rule) => rule.metric,
  '#RULE.THRESHOLD#': (_node, rule) => String(rule.threshold),
  '#RULE.DURATION#': (_node, rule) => String(rule.durationSec),
  '#VALUE#': (_node, _rule, value) => (value === null || value === undefined ? 'n/a' : String(Math.round(value * 100) / 100)),
  '#TIME#': () => new Date().toLocaleString('zh-CN'),
  '#STATE#': (_node, _rule, _value, state) => (state === 'firing' ? '触发' : '恢复'),
  '#MESSAGE#': (_node, _rule, _value, _state, message) => message ?? '',
}

/** All placeholder names, for the editor's hint list and for the tests. */
export const PLACEHOLDER_NAMES = Object.keys(PLACEHOLDERS)

/** A percentage with no decimals, or `n/a`. */
function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : 'n/a'
}

/** Memory use as a percentage, or undefined when the host did not report a total. */
function memoryPct(node) {
  const total = node?.mem?.totalBytes
  const used = node?.mem?.usedBytes
  return Number.isFinite(total) && total > 0 && Number.isFinite(used) ? (used / total) * 100 : undefined
}

/** Disk use as a percentage, or undefined when the host did not report a total. */
function diskPct(node) {
  const total = node?.disk?.totalBytes
  const used = node?.disk?.usedBytes
  return Number.isFinite(total) && total > 0 && Number.isFinite(used) ? (used / total) * 100 : undefined
}

/**
 * Substitute every known placeholder in one string.
 *
 * Unknown `#...#` sequences are left alone rather than blanked: a typo in a
 * template should show up in the delivered message, where the operator can see
 * it, instead of silently becoming an empty string.
 *
 * @param {string} template - text possibly containing `#PLACEHOLDER#`.
 * @param {{node: object, rule: object, value: number|null, state: string, message: string}} context
 * @returns {string} the substituted text.
 */
export function renderTemplate(template, context) {
  if (typeof template !== 'string' || template === '') return ''
  let output = template
  for (const [token, resolve] of Object.entries(PLACEHOLDERS)) {
    if (!output.includes(token)) continue
    output = output.split(token).join(String(resolve(context.node, context.rule, context.value, context.state, context.message)))
  }
  return output
}

/**
 * Build the concrete request a channel describes.
 *
 * @param {object} channel - a `notify_channel` row.
 * @param {object} context - `{node, rule, value, state, message}`.
 * @returns {{url: URL, method: string, headers: object, body: string|null}}
 */
export function buildRequest(channel, context) {
  const url = new URL(renderTemplate(channel.url, context))
  const method = (channel.method ?? 'POST').toUpperCase()
  let headers = {}
  const rawHeaders = channel.headers ?? '{}'
  if (typeof rawHeaders === 'string' && rawHeaders !== '') {
    try {
      const parsed = JSON.parse(rawHeaders)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed).map(([name, value]) => [name, renderTemplate(String(value), context)]),
        )
      }
    } catch {
      // A channel with malformed JSON headers still sends its body: headers are a
      // convenience, and refusing to notify over a stray comma is worse.
    }
  }
  let body = renderTemplate(channel.body ?? '', context)
  // A GET with a body is not a request any webhook expects; drop it rather than
  // letting `fetch` throw on a method that forbids one.
  if (method === 'GET' || method === 'HEAD' || body === '') body = null
  if (body !== null && channel.bodyType === 'form') {
    headers = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', ...headers }
  } else if (body !== null) {
    headers = { 'content-type': 'application/json; charset=utf-8', ...headers }
  }
  return { url, method, headers, body }
}

/**
 * Send one rendered request.
 *
 * `fetch` cannot express "accept this certificate anyway", and a self-hosted
 * notification endpoint behind a self-signed certificate is common enough that
 * the `verifyTls` checkbox has to actually work, so this drops to `node:https`
 * for that case and keeps `fetch` for everything else.
 *
 * A failure is recorded on the channel and swallowed: an alert engine that throws
 * because one webhook is down stops watching every other host.
 *
 * @param {object} channel - a `notify_channel` row.
 * @param {object} context - `{node, rule, value, state, message}`.
 * @returns {Promise<{ok: boolean, status: number|null, error: string|null}>}
 */
export async function sendToChannel(channel, context) {
  let prepared
  try {
    prepared = buildRequest(channel, context)
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) }
  }
  const { url, method, headers, body } = prepared
  const verifyTls = channel.verifyTls !== 0 && channel.verifyTls !== false

  if (url.protocol === 'https:' && !verifyTls) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const request = httpsRequest(
        url,
        { method, headers, rejectUnauthorized: false, timeout: SEND_TIMEOUT_MS },
        (response) => {
          response.resume()
          response.on('end', () => {
            const status = response.statusCode ?? null
            finish(status !== null && status >= 200 && status < 300
              ? { ok: true, status, error: null }
              : { ok: false, status, error: `HTTP ${status}` })
          })
        },
      )
      request.on('timeout', () => { request.destroy(new Error('timed out')) })
      request.on('error', (error) => finish({ ok: false, status: null, error: error.message }))
      if (body !== null) request.write(body)
      request.end()
    })
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    await response.arrayBuffer().catch(() => {})
    return response.status >= 200 && response.status < 300
      ? { ok: true, status: response.status, error: null }
      : { ok: false, status: response.status, error: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Send one event to every channel in its group.
 *
 * Collapsing more than {@link MERGE_LIMIT} events in one evaluation into a single
 * digest is the caller's job (`AlertEngine`), because only the caller knows what
 * the rest of the batch was.
 *
 * @param {object[]} channels - rows from `notify_channel`.
 * @param {object} context - `{node, rule, value, state, message}`.
 * @returns {Promise<{sent: number, failed: number, errors: string[]}>}
 */
export async function sendToChannels(channels, context) {
  const results = await Promise.all(channels.map((channel) => sendToChannel(channel, context)))
  const errors = results.filter((result) => !result.ok).map((result) => result.error ?? 'unknown error')
  return { sent: results.filter((result) => result.ok).length, failed: errors.length, errors }
}

/**
 * Ready-made channel definitions the editor can insert with one click.
 *
 * `{key}` and `{chat}` stay as literals the operator replaces: shipping a real
 * token in a template would leak it into every database that ever opened the
 * dropdown.
 */
export const PRESETS = [
  {
    id: 'bark',
    label: 'Bark',
    url: 'https://api.day.app/{key}/#SERVER.NAME#',
    method: 'POST',
    bodyType: 'json',
    headers: '{}',
    body: '{"title":"#STATE# #RULE.NAME#","body":"#SERVER.ALIAS# #RULE.METRIC# = #VALUE#"}',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    url: 'https://api.telegram.org/bot{token}/sendMessage',
    method: 'POST',
    bodyType: 'json',
    headers: '{}',
    body: '{"chat_id":"{chat}","text":"#STATE# #RULE.NAME#\\n#SERVER.ALIAS# #RULE.METRIC# = #VALUE#"}',
  },
  {
    id: 'lark',
    label: '飞书',
    url: 'https://open.feishu.cn/open-apis/bot/v2/hook/{token}',
    method: 'POST',
    bodyType: 'json',
    headers: '{}',
    body: '{"msg_type":"text","content":{"text":"#STATE# #RULE.NAME# #SERVER.ALIAS# #RULE.METRIC# = #VALUE#"}}',
  },
  {
    id: 'wecom',
    label: '企业微信',
    url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}',
    method: 'POST',
    bodyType: 'json',
    headers: '{}',
    body: '{"msgtype":"text","text":{"content":"#STATE# #RULE.NAME# #SERVER.ALIAS# #RULE.METRIC# = #VALUE#"}}',
  },
]
