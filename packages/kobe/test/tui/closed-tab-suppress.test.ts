/**
 * A killed tab's host session survives in the 2s `pty.list` poll for one
 * tick; the orphan backstop must not adopt it back in that window (the
 * "ctrl+w needs two presses" regression), yet a kill that never lands must
 * resurface as a real orphan after the TTL.
 */

import { describe, expect, it } from "vitest"
import { isRecentlyClosedPtyKey, noteClosedPtyKey } from "../../src/tui/workspace/closed-tab-suppress"

describe("closed-tab-suppress", () => {
  it("suppresses a just-closed key and its split leaves, then expires", () => {
    noteClosedPtyKey("t1::tab-2", 1_000)
    expect(isRecentlyClosedPtyKey("t1::tab-2", 2_000)).toBe(true)
    // A split leaf belongs to its tab — same collapse orphan detection does.
    expect(isRecentlyClosedPtyKey("t1::tab-2::leaf-2", 2_000)).toBe(true)
    expect(isRecentlyClosedPtyKey("t1::tab-3", 2_000)).toBe(false)
  })

  it("resurfaces after the TTL so an unkillable session is still reported", () => {
    noteClosedPtyKey("t2::tab-1", 0)
    expect(isRecentlyClosedPtyKey("t2::tab-1", 16_000)).toBe(false)
  })
})
