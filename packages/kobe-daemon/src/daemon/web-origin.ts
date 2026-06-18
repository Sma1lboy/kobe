/**
 * Shared browser-Origin policy for daemon-hosted web routes and the PTY sidecar.
 *
 * Browser requests carry an Origin. Non-browser clients usually do not; those
 * are allowed because there is no ambient browser credential to forge.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

export function isLoopbackHost(hostname: unknown): boolean {
  return LOOPBACK_HOSTS.has(String(hostname ?? "").trim().toLowerCase())
}

export function originHostname(origin: string | null | undefined): string | null {
  try {
    if (!origin) return null
    const url = new URL(origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.hostname
  } catch {
    return null
  }
}

export function isLoopbackOrigin(origin: string | null | undefined): boolean {
  const hostname = originHostname(origin)
  return hostname !== null && isLoopbackHost(hostname)
}

export function originAllowed(
  origin: string | null | undefined,
  opts: { allowedHost?: string } = {},
): boolean {
  if (!origin) return true
  if (isLoopbackOrigin(origin)) return true
  const allowedHost = opts.allowedHost?.trim()
  if (!allowedHost) return false
  const hostname = originHostname(origin)
  return hostname !== null && hostname === allowedHost
}

export function allowedHostForBindHost(hostname: unknown): string | undefined {
  const host = String(hostname ?? "").trim()
  return host && !isLoopbackHost(host) ? host : undefined
}
