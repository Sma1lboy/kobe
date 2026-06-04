import { describe, expect, it } from "vitest"
import { isDaemonVersionStale, isProtocolCompatible } from "../../src/daemon/protocol.ts"

describe("isProtocolCompatible", () => {
  it("accepts two peers on the same version + min", () => {
    expect(isProtocolCompatible({ localVersion: 2, localMin: 2, remoteVersion: 2, remoteMin: 2 })).toBe(true)
  })

  it("lets an older client talk to a newer daemon when the min stayed put (rolling upgrade)", () => {
    // daemon bumped to v3 but still supports v2; client is v2/min2.
    expect(isProtocolCompatible({ localVersion: 2, localMin: 2, remoteVersion: 3, remoteMin: 2 })).toBe(true)
    // symmetric: newer daemon's view of the older client.
    expect(isProtocolCompatible({ localVersion: 3, localMin: 2, remoteVersion: 2, remoteMin: 2 })).toBe(true)
  })

  it("rejects a peer older than our minimum", () => {
    // remote is v1, but we no longer speak below v2.
    expect(isProtocolCompatible({ localVersion: 2, localMin: 2, remoteVersion: 1, remoteMin: 1 })).toBe(false)
  })

  it("rejects when we are older than the remote's minimum", () => {
    // remote dropped support below v3; we are still v2.
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
    // User ran `npm i -g @sma1lboy/kobe@latest` (client v0.7.4) but the
    // long-lived daemon is still running v0.7.3 in memory.
    expect(isDaemonVersionStale("0.7.3", "0.7.4")).toBe(true)
  })

  it("is stale when the daemon is NEWER than the client (mismatched either direction)", () => {
    // Any difference at all is worth a restart prompt — a plain inequality,
    // not a semver ordering.
    expect(isDaemonVersionStale("0.8.0", "0.7.4")).toBe(true)
  })

  it("is NOT stale when the daemon version is unknown (older daemon omits the field)", () => {
    // A daemon predating the kobeVersion handshake field reports undefined;
    // we must never flag that as stale (no false banner).
    expect(isDaemonVersionStale(undefined, "0.7.4")).toBe(false)
  })

  it("is not stale on an empty daemon version string (treated as unknown)", () => {
    expect(isDaemonVersionStale("", "0.7.4")).toBe(false)
  })
})
