import { isWindowsPipePath, windowsPipePath } from "@sma1lboy/kobe-daemon/daemon/paths"
import { describe, expect, test } from "vitest"

describe("windowsPipePath", () => {
  test("is stable per home + role, and distinct across both", () => {
    const a = windowsPipePath("C:\\Users\\dev", "pty")
    expect(a).toBe(windowsPipePath("C:\\Users\\dev", "pty"))
    expect(a).toMatch(/^\\\\\.\\pipe\\kobe-[0-9a-f]{8}-pty$/)
    // A sandbox home must never share a host with production.
    expect(a).not.toBe(windowsPipePath("C:\\Users\\dev\\sandbox", "pty"))
    expect(a).not.toBe(windowsPipePath("C:\\Users\\dev", "daemon"))
  })
})

describe("isWindowsPipePath", () => {
  test("recognises both pipe spellings", () => {
    expect(isWindowsPipePath("\\\\.\\pipe\\kobe-abc12345-pty")).toBe(true)
    expect(isWindowsPipePath("//./pipe/kobe-abc12345-pty")).toBe(true)
  })

  test("rejects filesystem socket paths", () => {
    // A false positive here would skip the unlink that clears a stale unix
    // socket on POSIX, stranding the next host behind an EADDRINUSE.
    expect(isWindowsPipePath("/Users/dev/.kobe/pty.sock")).toBe(false)
    expect(isWindowsPipePath("C:\\Users\\dev\\.kobe\\pty.sock")).toBe(false)
    expect(isWindowsPipePath("/tmp/kobe-abc12345-pty.sock")).toBe(false)
  })
})
