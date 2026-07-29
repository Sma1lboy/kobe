import { describe, expect, it } from "vitest"
/**
 * Pins the SDK's shipped copies of the wire contract to the host's own
 * definitions. If the daemon adds/renames an event or channel, this test
 * fails until the SDK copy is updated — the published package must never
 * silently drift from the host.
 */
// Relative imports into the sibling workspace package on purpose: this test
// runs only in-repo, and channels.ts isn't part of the daemon's public
// exports map — the SDK must not widen that surface just to test against it.
import { CHANNEL_NAMES } from "../../kobe-daemon/src/daemon/channels.ts"
import { PLUGIN_EVENT_NAMES as HOST_EVENT_NAMES } from "../../kobe-daemon/src/plugins/manifest.ts"
import { DAEMON_CHANNELS, PLUGIN_EVENT_NAMES } from "../src/types.ts"

describe("SDK ↔ host contract", () => {
  it("event names match the daemon's catalog exactly", () => {
    expect([...PLUGIN_EVENT_NAMES]).toEqual([...HOST_EVENT_NAMES])
  })

  it("channel names match the daemon's channel registry exactly", () => {
    expect([...DAEMON_CHANNELS].sort()).toEqual([...CHANNEL_NAMES].sort())
  })
})
