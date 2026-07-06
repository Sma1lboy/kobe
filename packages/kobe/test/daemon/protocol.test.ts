import {
  isChannelName,
  isDaemonVersionStale,
  isProtocolCompatible,
  normalizeChannelFilter,
} from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"

describe("isProtocolCompatible", () => {
  it("accepts two peers on the same version + min", () => {
    expect(isProtocolCompatible({ localVersion: 2, localMin: 2, remoteVersion: 2, remoteMin: 2 })).toBe(true)
  })

  it("lets an older client talk to a newer daemon when the min stayed put (rolling upgrade)", () => {
    expect(isProtocolCompatible({ localVersion: 2, localMin: 2, remoteVersion: 3, remoteMin: 2 })).toBe(true)
    expect(isProtocolCompatible({ localVersion: 3, localMin: 2, remoteVersion: 2, remoteMin: 2 })).toBe(true)
  })

  it("rejects a peer older than our minimum", () => {
    expect(isProtocolCompatible({ localVersion: 2, localMin: 2, remoteVersion: 1, remoteMin: 1 })).toBe(false)
  })

  it("rejects when we are older than the remote's minimum", () => {
    expect(isProtocolCompatible({ localVersion: 2, localMin: 2, remoteVersion: 3, remoteMin: 3 })).toBe(false)
  })

  it("is symmetric", () => {
    const a = { localVersion: 4, localMin: 2 }
    const b = { localVersion: 2, localMin: 2 }
    const ab = isProtocolCompatible({ ...a, remoteVersion: b.localVersion, remoteMin: b.localMin })
    const ba = isProtocolCompatible({ ...b, remoteVersion: a.localVersion, remoteMin: a.localMin })
    expect(ab).toBe(ba)
  })
})

describe("isDaemonVersionStale", () => {
  it("is not stale when daemon and client are the same build", () => {
    expect(isDaemonVersionStale("0.7.4", "0.7.4")).toBe(false)
  })

  it("is stale when the daemon is OLDER than the client (the common upgrade case)", () => {
    expect(isDaemonVersionStale("0.7.3", "0.7.4")).toBe(true)
  })

  it("is stale when the daemon is NEWER than the client (mismatched either direction)", () => {
    expect(isDaemonVersionStale("0.8.0", "0.7.4")).toBe(true)
  })

  it("is NOT stale when the daemon version is unknown (older daemon omits the field)", () => {
    expect(isDaemonVersionStale(undefined, "0.7.4")).toBe(false)
  })

  it("is not stale on an empty daemon version string (treated as unknown)", () => {
    expect(isDaemonVersionStale("", "0.7.4")).toBe(false)
  })
})

describe("isChannelName", () => {
  it("accepts a real channel name", () => {
    expect(isChannelName("ui-prefs")).toBe(true)
    expect(isChannelName("task.snapshot")).toBe(true)
  })

  it("rejects unknown / non-string values", () => {
    expect(isChannelName("daemon.stopping")).toBe(false)
    expect(isChannelName("nope")).toBe(false)
    expect(isChannelName(42)).toBe(false)
    expect(isChannelName(undefined)).toBe(false)
  })
})

describe("normalizeChannelFilter", () => {
  it("returns null (deliver-everything) for an omitted / non-array request", () => {
    expect(normalizeChannelFilter(undefined)).toBeNull()
    expect(normalizeChannelFilter("ui-prefs")).toBeNull()
    expect(normalizeChannelFilter({})).toBeNull()
  })

  it("returns the requested set of valid channels", () => {
    const set = normalizeChannelFilter(["ui-prefs", "keybindings"])
    expect(set).not.toBeNull()
    expect([...(set ?? [])].sort()).toEqual(["keybindings", "ui-prefs"])
  })

  it("drops unknown names (forward-compat) but keeps the valid ones", () => {
    const set = normalizeChannelFilter(["ui-prefs", "future-channel", 7])
    expect([...(set ?? [])]).toEqual(["ui-prefs"])
  })

  it("returns null when the filter has zero valid channels (deliver-everything)", () => {
    expect(normalizeChannelFilter([])).toBeNull()
    expect(normalizeChannelFilter(["bogus", 1])).toBeNull()
  })
})
