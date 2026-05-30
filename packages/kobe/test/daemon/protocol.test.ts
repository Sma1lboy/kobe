import { describe, expect, it } from "vitest"
import { isProtocolCompatible } from "../../src/daemon/protocol.ts"

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
