import { allowedHostForBindHost, isLoopbackOrigin, originAllowed } from "@sma1lboy/kobe-daemon/daemon/web-origin"
import { describe, expect, it } from "vitest"

/**
 * Browser-Origin policy for daemon-hosted web routes.
 *
 * Regression (this file): a bind host carrying any uppercase letter — routine
 * for mDNS names like `MyMac.local` — used to 403 every browser request. The
 * browser (and `new URL().hostname`) lowercase the Origin host, but the allowed
 * bind host was compared with its original case, so `mymac.local === MyMac.local`
 * was false. Hostnames are case-insensitive (RFC 4343); the comparison now is.
 */
describe("originAllowed", () => {
  it("allows a request with no Origin (non-browser client)", () => {
    expect(originAllowed(null)).toBe(true)
    expect(originAllowed(undefined)).toBe(true)
    expect(originAllowed("")).toBe(true)
  })

  it("allows any loopback Origin regardless of the allowed host", () => {
    expect(originAllowed("http://localhost:45174")).toBe(true)
    expect(originAllowed("http://127.0.0.1:45174")).toBe(true)
    expect(originAllowed("http://[::1]:45174")).toBe(true)
    expect(originAllowed("http://localhost:45174", { allowedHost: "example.local" })).toBe(true)
  })

  it("rejects a non-loopback Origin when no host is allowed", () => {
    expect(originAllowed("http://kobe.local:45174")).toBe(false)
    expect(originAllowed("http://kobe.local:45174", { allowedHost: "" })).toBe(false)
    expect(originAllowed("http://kobe.local:45174", { allowedHost: "   " })).toBe(false)
  })

  it("allows the exact allowed host", () => {
    expect(originAllowed("http://kobe.local:45174", { allowedHost: "kobe.local" })).toBe(true)
    expect(originAllowed("https://192.168.1.20:45174", { allowedHost: "192.168.1.20" })).toBe(true)
  })

  it("matches a mixed-case bind host case-insensitively (RFC 4343)", () => {
    // The browser lowercases the Origin host; the bind host keeps its case.
    expect(originAllowed("http://mymac.local:45174", { allowedHost: "MyMac.local" })).toBe(true)
    expect(originAllowed("http://johns-mbp.local:45174", { allowedHost: "Johns-MBP.local" })).toBe(true)
    expect(originAllowed("http://host.example:45174", { allowedHost: "HOST.EXAMPLE" })).toBe(true)
  })

  it("rejects a genuinely different host", () => {
    expect(originAllowed("http://evil.example:45174", { allowedHost: "kobe.local" })).toBe(false)
  })

  it("rejects a non-http(s) Origin scheme", () => {
    expect(originAllowed("file:///etc/passwd", { allowedHost: "kobe.local" })).toBe(false)
    expect(originAllowed("ws://kobe.local", { allowedHost: "kobe.local" })).toBe(false)
  })
})

describe("isLoopbackOrigin", () => {
  it("recognizes loopback hosts and nothing else", () => {
    expect(isLoopbackOrigin("http://localhost")).toBe(true)
    expect(isLoopbackOrigin("http://127.0.0.1:45174")).toBe(true)
    expect(isLoopbackOrigin("http://192.168.1.5")).toBe(false)
    expect(isLoopbackOrigin(null)).toBe(false)
  })
})

describe("allowedHostForBindHost", () => {
  it("drops loopback bind hosts (nothing to gate — loopback is always allowed)", () => {
    expect(allowedHostForBindHost("127.0.0.1")).toBeUndefined()
    expect(allowedHostForBindHost("localhost")).toBeUndefined()
    expect(allowedHostForBindHost("::1")).toBeUndefined()
    expect(allowedHostForBindHost("")).toBeUndefined()
    expect(allowedHostForBindHost(undefined)).toBeUndefined()
  })

  it("keeps a real LAN bind host, and originAllowed accepts its browser Origin despite case", () => {
    const allowedHost = allowedHostForBindHost("MyMac.local")
    expect(allowedHost).toBe("MyMac.local")
    expect(originAllowed("http://mymac.local:45174", { allowedHost })).toBe(true)
  })
})
