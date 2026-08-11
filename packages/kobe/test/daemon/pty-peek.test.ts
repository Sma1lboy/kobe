/**
 * `peekRing` — the pure half of `pty.peek` (read-only ring snapshot for
 * `kobe api read-output`'s terminal fallback). Exercised directly with a
 * fake session view: slicing math and the missing-key shape must hold
 * without ever attaching to or spawning a PTY.
 */

import { type PtyRingView, peekRing } from "@sma1lboy/kobe-daemon/daemon/pty-observability"
import { describe, expect, it } from "vitest"

function view(chunks: string[], trimmedBytes = 0, alive = true, pid: number | null = 7): PtyRingView {
  const bufs = chunks.map((c) => Buffer.from(c, "utf8"))
  const bytes = bufs.reduce((n, b) => n + b.byteLength, 0)
  return {
    alive,
    chunks: bufs,
    bytes,
    totalBytes: bytes + trimmedBytes,
    proc: pid === null ? null : { pid },
  }
}

describe("peekRing", () => {
  it("reports a missing session without creating anything", () => {
    expect(peekRing(undefined)).toEqual({
      exists: false,
      alive: false,
      pid: null,
      offset: 0,
      data: "",
      sinceValid: false,
      exit: null,
    })
  })

  it("returns the full ring with the monotonic offset", () => {
    const res = peekRing(view(["hello ", "world"]))
    expect(res.exists).toBe(true)
    expect(res.alive).toBe(true)
    expect(res.pid).toBe(7)
    expect(res.offset).toBe(11)
    expect(Buffer.from(res.data, "base64").toString("utf8")).toBe("hello world")
    expect(res.sinceValid).toBe(false)
  })

  it("returns the exact delta when sinceOffset is inside the ring window", () => {
    const res = peekRing(view(["hello ", "world"]), 6)
    expect(res.sinceValid).toBe(true)
    expect(Buffer.from(res.data, "base64").toString("utf8")).toBe("world")
  })

  it("accounts for trimmed bytes: window offsets stay comparable across trims", () => {
    // 100 bytes were trimmed away; the ring holds the last 11.
    const trimmed = view(["hello ", "world"], 100)
    const inWindow = peekRing(trimmed, 106)
    expect(inWindow.sinceValid).toBe(true)
    expect(Buffer.from(inWindow.data, "base64").toString("utf8")).toBe("world")

    // An offset older than the window falls back to the full ring, labeled.
    const stale = peekRing(trimmed, 50)
    expect(stale.sinceValid).toBe(false)
    expect(Buffer.from(stale.data, "base64").toString("utf8")).toBe("hello world")
    expect(stale.offset).toBe(111)
  })

  it("reports a dead child and a failed spawn honestly", () => {
    expect(peekRing(view(["bye"], 0, false)).alive).toBe(false)
    expect(peekRing(view([], 0, true, null)).pid).toBeNull()
  })
})
