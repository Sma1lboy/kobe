import { CHANNEL_NAMES } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"
import { SPA_CHANNEL_SET, SPA_CHANNELS } from "../server/spa-channels.ts"


const SPA_CONSUMED = [
  "task.snapshot",
  "issue.snapshot",
  "active-task",
  "engine-state",
  "update",
  "task.jobs",
  "worktree.changes",
  "session.deliver",
  "ui-prefs",
] as const

const SPA_DROPPED = ["keybindings", "transcript.activity"] as const

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
