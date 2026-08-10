import type { DaemonRuntimeAdapter } from "@sma1lboy/kobe-daemon/daemon/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"
import { daemonRuntime } from "../../src/core/daemon-runtime.ts"
import { type DaemonHarness, bootDaemonHarness, waitFor } from "./harness.ts"

describe("quota usage collector subscription wake", () => {
  let h: DaemonHarness

  afterEach(async () => {
    await h.close()
  })

  it("fetches immediately when the first subscriber attaches", async () => {
    const capturedAt = Date.now()
    const quotaUsage = vi.fn(async () => ({
      capturedAt,
      windows: [{ kind: "primary", label: "7d", percent: 12, resetsAt: capturedAt + 60_000 }],
    }))
    const runtime: DaemonRuntimeAdapter = {
      ...daemonRuntime,
      quotaUsage,
      vendorsWithQuotaProbe: () => ["codex"],
    }
    h = await bootDaemonHarness({
      // The production poll interval is 60 seconds, far outside the
      // assertion window. The subscriber transition itself must wake it.
      server: { runtime },
    })

    expect(quotaUsage).not.toHaveBeenCalled()

    const client = h.client()
    let usagePayload: unknown
    client.on("usage.snapshot", (frame) => {
      usagePayload = frame.payload
    })
    await client.subscribe({ role: "gui" })

    expect(await waitFor(() => quotaUsage.mock.calls.length === 1, 500)).toBe(true)
    expect(await waitFor(() => usagePayload != null, 500)).toBe(true)
    expect(usagePayload).toEqual({
      usage: {
        codex: {
          capturedAt,
          windows: [{ kind: "primary", label: "7d", percent: 12, resetsAt: capturedAt + 60_000 }],
        },
      },
    })

    const secondClient = h.client()
    await secondClient.subscribe({ role: "pane" })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(quotaUsage).toHaveBeenCalledTimes(1)
  })
})
