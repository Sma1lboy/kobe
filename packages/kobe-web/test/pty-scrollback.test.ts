import { describe, expect, it } from "vitest"
// The ring lives as a plain .mjs so the node-only pty-server can import it
// without a TS loader; vitest/esbuild resolves the .mjs here just fine.
import { createScrollback } from "../pty-scrollback.mjs"

describe("createScrollback", () => {
  it("replays everything while under the cap", () => {
    const sb = createScrollback(100)
    sb.push("abc")
    sb.push("def")
    expect(sb.replay()).toBe("abcdef")
    expect(sb.length()).toBe(6)
  })

  it("returns empty before any output and ignores empty chunks", () => {
    const sb = createScrollback(100)
    expect(sb.replay()).toBe("")
    expect(sb.length()).toBe(0)
    sb.push("")
    expect(sb.replay()).toBe("")
    expect(sb.chunkCount()).toBe(0)
  })

  it("drops whole chunks off the head once over cap, keeping recent output", () => {
    const sb = createScrollback(5)
    sb.push("aaa") // 3
    sb.push("bbb") // 6 > 5 → drop "aaa" (back to 3)
    expect(sb.replay()).toBe("bbb")
    expect(sb.length()).toBe(3)
    sb.push("cc") // 5, still ≤ cap
    expect(sb.replay()).toBe("bbbcc")
    expect(sb.length()).toBe(5)
  })

  it("never drops the only (oversized) chunk", () => {
    const sb = createScrollback(4)
    const big = "x".repeat(50)
    sb.push(big)
    expect(sb.replay()).toBe(big)
    expect(sb.chunkCount()).toBe(1)
    expect(sb.length()).toBe(50)
  })

  it("is O(chunk) per push — many small chunks keep the ring bounded near the cap", () => {
    const cap = 1024
    const sb = createScrollback(cap)
    // Simulate a heavy stream: 10k tiny chunks. The whole point of the ring is
    // that this stays bounded (no per-chunk O(cap) reflatten); we assert the
    // retained window never balloons past one chunk over the cap.
    for (let i = 0; i < 10_000; i++) sb.push("ab")
    expect(sb.length()).toBeLessThanOrEqual(cap + 2)
    expect(sb.length()).toBeGreaterThan(cap - 2)
    // Replay reconstructs a contiguous tail of the stream.
    const replay = sb.replay()
    expect(replay.length).toBe(sb.length())
    expect(replay).toMatch(/^(ab)+$/)
  })
})
