import { AttentionInboxStore } from "@sma1lboy/kobe-daemon/daemon/attention-inbox"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type DaemonHarness, bootDaemonHarness } from "./harness.ts"

describe("daemon attention inbox startup", () => {
  let harness: DaemonHarness | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    await harness?.close()
    harness = null
  })

  it("keeps the daemon live when Inbox initialization rejects", async () => {
    vi.spyOn(AttentionInboxStore.prototype, "init").mockRejectedValueOnce(new Error("inbox unavailable"))

    harness = await bootDaemonHarness()

    expect(harness.server.socketPath).toBe(harness.socketPath)
  })
})
