/**
 * Per-channel subscribe filter — daemon → client round-trip (KOB —
 * per-channel subscribe). The daemon used to write EVERY channel frame to
 * EVERY subscribed socket; a narrow consumer (host-boot's UiPrefsSync wants
 * only ui-prefs + keybindings) still received — and parsed — the full
 * `task.snapshot` fan-out it never reads. The reserved `channels` filter is
 * now enforced: a filtered subscriber gets ONLY its channels in both the
 * connect-time replay and later broadcasts; an UNfiltered subscriber still
 * gets everything (back-compat). Exercised over the real Unix socket.
 */

import { afterEach, describe, expect, it } from "vitest"
import { type DaemonHarness, bootDaemonHarness, waitFor } from "./harness.ts"

describe("per-channel subscribe filter (daemon → client)", () => {
  let h: DaemonHarness

  afterEach(async () => {
    await h.close()
  })

  /**
   * Boot with a live keybindings watcher (its debounce fires an initial
   * `keybindings` rev) — that channel is the "wanted" one; `task.snapshot`
   * (warmed by the fake orchestrator's eager subscribeTasks fire) is the
   * "unwanted" one a filtered subscriber must NOT receive.
   */
  function boot(): Promise<DaemonHarness> {
    return bootDaemonHarness({ server: { keybindingsDebounceMs: 25 } })
  }

  it("a filtered subscriber receives only its channels in the replay", async () => {
    h = await boot()

    const client = h.client()
    const channels: string[] = []
    client.on("*", (frame) => {
      if (frame.name !== "daemon.stopping") channels.push(frame.name)
    })
    // Filter to keybindings only — task.snapshot (warmed by subscribeTasks'
    // eager fire) must NOT arrive.
    await client.subscribe({ channels: ["keybindings"] })

    await waitFor(() => channels.includes("keybindings"))
    expect(channels).toContain("keybindings")
    expect(channels).not.toContain("task.snapshot")

    client.close()
  })

  it("an unfiltered subscriber still receives every channel (back-compat)", async () => {
    h = await boot()

    const client = h.client()
    const channels: string[] = []
    client.on("*", (frame) => {
      if (frame.name !== "daemon.stopping") channels.push(frame.name)
    })
    await client.subscribe()

    await waitFor(() => channels.includes("task.snapshot") && channels.includes("keybindings"))
    expect(channels).toContain("task.snapshot")
    expect(channels).toContain("keybindings")

    client.close()
  })
})
