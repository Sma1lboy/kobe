import { describe, expect, it } from "vitest"
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
    sb.push("aaa")
    sb.push("bbb")
    expect(sb.replay()).toBe("bbb")
    expect(sb.length()).toBe(3)
    sb.push("cc")
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
    for (let i = 0; i < 10_000; i++) sb.push("ab")
    expect(sb.length()).toBeLessThanOrEqual(cap + 2)
    expect(sb.length()).toBeGreaterThan(cap - 2)
    const replay = sb.replay()
    expect(replay.length).toBe(sb.length())
    expect(replay).toMatch(/^(ab)+$/)
  })
})
