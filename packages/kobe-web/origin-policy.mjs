
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname ?? "").trim().toLowerCase())
}

export function originHostname(origin) {
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.hostname
  } catch {
    return null
  }
}

export function isLoopbackOrigin(origin) {
  const hostname = originHostname(origin)
  return hostname !== null && isLoopbackHost(hostname)
}

export function originAllowed(origin, opts = {}) {
  if (!origin) return true
  if (isLoopbackOrigin(origin)) return true
  const allowedHost = opts.allowedHost?.trim()
  if (!allowedHost) return false
  const hostname = originHostname(origin)
  return hostname !== null && hostname === allowedHost
}

export function allowedHostForBindHost(hostname) {
  const host = String(hostname ?? "").trim()
  return host && !isLoopbackHost(host) ? host : undefined
}
