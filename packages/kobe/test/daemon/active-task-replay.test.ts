/**
 * Connect-time replay of the restored focus (`active-task` channel).
 *
 * Why this matters: the orchestrator seeds its active-task signal from the
 * persisted `lastActive` record, but the channel used to be published only
 * by the `task.setActive` handler — a FRESH daemon replayed tasks with no
 * focus, so every newly attached TUI fell back to "first task in the list"
 * instead of the last focused one (the "opens on the wrong task" bug).
 * The server now warms the channel at startup; this pins that behavior
 * over the real Unix socket.
 */

import { afterEach, describe, expect, it } from "vitest"
import { type DaemonHarness, bootDaemonHarness, fakeOrchestrator, waitFor } from "./harness.ts"

describe("active-task connect-time replay", () => {
  let h: DaemonHarness

  afterEach(async () => {
    await h.close()
  })

  async function replayedActiveTask(taskId: string | null): Promise<string | null | undefined> {
    // Minimal orchestrator whose restored focus is `taskId`.
    h = await bootDaemonHarness({
      orchestrator: fakeOrchestrator({ activeTaskSignal: () => () => taskId }),
    })
    const client = h.client()
    let seen: string | null | undefined
    let arrived = false
    client.on("active-task", (frame) => {
      seen = (frame.payload as { taskId?: string | null }).taskId
      arrived = true
    })
    await client.subscribe()
    await waitFor(() => arrived)
    client.close()
    return arrived ? seen : undefined
  }

  it("a fresh daemon replays the orchestrator's restored focus", async () => {
    expect(await replayedActiveTask("task-42")).toBe("task-42")
  })

  it("no persisted focus replays an explicit null, not a cold channel", async () => {
    expect(await replayedActiveTask(null)).toBeNull()
  })
})
