/**
 * Small HTTP helpers shared by the route family: JSON bodies in, JSON out, and
 * one guard that enforces the loopback fence and the expected method.
 *
 * @module dsh-fleet-monitor/http
 */

import { isLoopbackRequest } from './loopback.js'

/** Bodies larger than this are refused before buffering (defensive only). */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Read and parse a JSON request body.
 * @param request - node HTTP request.
 * @returns the parsed value, or null when the body is absent or invalid.
 */
export async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Write a JSON response.
 * @param response - node HTTP response.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable payload.
 */
export function writeJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // A monitoring payload is per-request truth; never let a proxy or the
    // browser serve a stale fleet view.
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * Fence + method check in one call.
 * @param request - node HTTP request.
 * @param response - node HTTP response.
 * @param methods - accepted HTTP methods.
 * @returns true when the caller may proceed; otherwise a response was written.
 */
export function guard(request, response, methods) {
  if (!isLoopbackRequest(request)) {
    writeJson(response, 403, { error: 'forbidden: loopback-only' })
    return false
  }
  const method = request.method ?? 'GET'
  if (!methods.includes(method)) {
    writeJson(response, 405, { error: `method not allowed: ${method}` })
    return false
  }
  return true
}
