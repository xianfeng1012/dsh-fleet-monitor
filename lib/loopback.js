/**
 * Loopback trust fence for this plugin's route family.
 *
 * Every endpoint here can be commanded by a web page and reports the internal
 * topology of an operator's fleet, so it is served to the local machine only:
 * a loopback socket, a loopback `Host` header, and browser same-origin markers.
 *
 * A request that carries `X-Forwarded-For` or `CF-Connecting-IP` is refused
 * outright. A reverse proxy dials `127.0.0.1`, so both the socket address and
 * the Host header of a proxied request describe the proxy, not the caller —
 * forwarding headers are the only signal that a hop stands in between, and they
 * are never evidence *for* loopback.
 *
 * @module dsh-fleet-monitor/loopback
 */

/** IPv4 127/8 predicate. */
export function isIPv4Loopback(value) {
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether an address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a hostname names the loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Whether a forwarding header proves a proxy stood in between. */
export function isProxiedRequest(request) {
  return request.headers['cf-connecting-ip'] !== undefined
    || request.headers['x-forwarded-for'] !== undefined
}

/**
 * Decide whether a request may reach this plugin's routes.
 * @param request - node HTTP request.
 * @returns true for a same-origin browser request from the local machine.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  if (isProxiedRequest(request)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
