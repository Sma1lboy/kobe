import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { SessionBindingStore } from "@sma1lboy/kobe-daemon/daemon/session-bindings"
import { describe, expect, it } from "vitest"

async function loadCurrent(runs: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "kobe-session-binding-recovery-"))
  const path = join(dir, "session-bindings.json")
  const current = runs.at(-1) as { taskId: string; tabId: string; runId: string }
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      runs,
      currentRuns: [{ taskId: current.taskId, tabId: current.tabId, runId: current.runId }],
    }),
    "utf8",
  )
  const store = new SessionBindingStore(path, new DaemonEventBus(), () => 40)
  await store.init()
  return store
}

const orphan = {
  runId: "orphan",
  taskId: "task-1",
  tabId: "tab-a",
  vendor: "codex",
  sessionId: null,
  state: "pending",
  source: "spawn",
  startedAt: 30,
  updatedAt: 30,
}

describe("SessionBindingStore recovery", () => {
  it("marks an orphan pending run empty instead of attaching historical identity", async () => {
    const store = await loadCurrent([
      {
        ...orphan,
        runId: "identified",
        sessionId: "session-1",
        state: "superseded",
        source: "hook",
        startedAt: 10,
        updatedAt: 20,
      },
      orphan,
    ])
    expect(store.snapshotByTask()["task-1"]?.["tab-a"]).toMatchObject({
      runId: "orphan",
      sessionId: null,
      state: "missing",
    })
    expect(store.runsSnapshot()).toContainEqual(
      expect.objectContaining({ runId: "identified", sessionId: "session-1", state: "superseded" }),
    )
  })

  it("marks an orphan pending current run missing when no identity can be restored", async () => {
    const store = await loadCurrent([orphan])
    expect(store.snapshotByTask()["task-1"]?.["tab-a"]).toMatchObject({ runId: "orphan", state: "missing" })
  })
})
