import { CHANNEL_NAMES } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"
import { SPA_CHANNEL_SET, SPA_CHANNELS } from "../server/spa-channels.ts"

/**
 * The bridge filters daemon channels down to SPA_CHANNELS before fanning them
 * out over SSE. This locks the whitelist to what the SPA's reducer in
 * `src/lib/store.ts` (`applyEvent`) + the `snapshot` hydration actually read.
 * If a future channel becomes consumed by the SPA, add it BOTH to store.ts's
 * `applyEvent` and here — this test is the gate that catches the drift.
 */

// The exact set the SPA reducer handles today (mirror of store.ts applyEvent's
// switch cases + the snapshot event's fields).
const SPA_CONSUMED = [
  "task.snapshot",
  "active-task",
  "engine-state",
  "update",
  "task.jobs",
  "worktree.changes",
  "task.conflicts",
  "session.deliver",
  "ui-prefs",
] as const

// The daemon channels the SPA deliberately drops — bytes it never renders.
const SPA_DROPPED = ["keybindings"] as const

describe("SPA_CHANNELS whitelist", () => {
  it("is exactly the channels the SPA reducer consumes", () => {
    expect([...SPA_CHANNELS].sort()).toEqual([...SPA_CONSUMED].sort())
  })

  it("only names real daemon channels (subset of the protocol's CHANNEL_NAMES)", () => {
    for (const ch of SPA_CHANNELS) {
      expect(CHANNEL_NAMES).toContain(ch)
    }
  })

  it("drops every channel the SPA never renders", () => {
    for (const ch of SPA_DROPPED) {
      expect(SPA_CHANNEL_SET.has(ch)).toBe(false)
    }
  })

  it("partitions the protocol channels into consumed vs dropped with no gaps", () => {
    // Every daemon channel is accounted for as either consumed or dropped —
    // so a newly-added protocol channel can't silently slip through unfiltered.
    const accounted = new Set<string>([...SPA_CONSUMED, ...SPA_DROPPED])
    for (const ch of CHANNEL_NAMES) {
      expect(accounted.has(ch)).toBe(true)
    }
    expect(accounted.size).toBe(CHANNEL_NAMES.length)
  })

  it("SPA_CHANNEL_SET membership matches SPA_CHANNELS", () => {
    expect(SPA_CHANNEL_SET.size).toBe(SPA_CHANNELS.length)
    for (const ch of SPA_CHANNELS) expect(SPA_CHANNEL_SET.has(ch)).toBe(true)
  })
})
