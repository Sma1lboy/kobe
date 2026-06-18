import { describe, expect, it } from "vitest"
import {
  allowedHostForBindHost,
  isLoopbackHost,
  isLoopbackOrigin,
  originAllowed,
  originHostname,
} from "../origin-policy.mjs"

describe("origin policy", () => {
  it("allows Origin-less non-browser clients", () => {
    expect(originAllowed(undefined)).toBe(true)
    expect(originAllowed(null)).toBe(true)
    expect(originAllowed("")).toBe(true)
  })

  it("recognizes loopback hosts and Origins", () => {
    expect(isLoopbackHost("localhost")).toBe(true)
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("[::1]")).toBe(true)
    expect(isLoopbackOrigin("http://localhost:5173")).toBe(true)
    expect(isLoopbackOrigin("https://127.0.0.1")).toBe(true)
  })

  it("rejects malformed, non-http, and non-loopback Origins by default", () => {
    expect(originAllowed("not a url")).toBe(false)
    expect(originAllowed("file://localhost/tmp/x")).toBe(false)
    expect(originAllowed("http://attacker.example")).toBe(false)
  })

  it("allows a deliberate LAN host by hostname only", () => {
    expect(originHostname("http://192.168.1.5:5173")).toBe("192.168.1.5")
    expect(originAllowed("http://192.168.1.5:5173", { allowedHost: "192.168.1.5" })).toBe(true)
    expect(originAllowed("http://192.168.1.6:5173", { allowedHost: "192.168.1.5" })).toBe(false)
  })

  it("derives allowedHost from the bind host only for non-loopback binds", () => {
    expect(allowedHostForBindHost("127.0.0.1")).toBeUndefined()
    expect(allowedHostForBindHost("localhost")).toBeUndefined()
    expect(allowedHostForBindHost("192.168.1.5")).toBe("192.168.1.5")
  })
})
