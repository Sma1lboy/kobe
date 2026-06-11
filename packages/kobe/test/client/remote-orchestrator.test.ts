import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { describe, expect, it } from "vitest"
import { RemoteOrchestrator } from "../../src/client/remote-orchestrator.ts"

/**
 * Minimal fake daemon client: RemoteOrchestrator only needs `on("*", …)`
 * (to receive channel events) and `onLifecycle` (for the close hook) at
 * construction time. `emit` replays a daemon event frame through the
 * captured `*` handler, exactly as the real socket layer would.
 */
function fakeClient(): { client: KobeDaemonClient; emit: (name: string, payload: unknown) => void } {
  let star: ((frame: { name: string; payload: unknown }) => void) | undefined
  const client = {
    on: (name: string, handler: (frame: { name: string; payload: unknown }) => void) => {
      if (name === "*") star = handler
      return () => {}
    },
    onLifecycle: () => () => {},
  } as unknown as KobeDaemonClient
  return { client, emit: (name, payload) => star?.({ name, payload }) }
}

describe("RemoteOrchestrator channel handling", () => {
  it("reflects the daemon-owned `update` channel in updateSignal", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    expect(orch.updateSignal()()).toBeNull()

    const info = { current: "1.0.0", latest: "1.1.0", hasUpdate: true }
    emit("update", { info })
    expect(orch.updateSignal()()).toEqual(info)

    // A later null poll (dev/offline) clears the signal; the consuming pane
    // is what keeps the last-known value sticky, not the orchestrator.
    emit("update", { info: null })
    expect(orch.updateSignal()()).toBeNull()
  })

  it("reflects the `active-task` channel in activeTaskSignal", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    expect(orch.activeTaskSignal()()).toBeNull()

    emit("active-task", { taskId: "t1" })
    expect(orch.activeTaskSignal()()).toBe("t1")

    emit("active-task", { taskId: null })
    expect(orch.activeTaskSignal()()).toBeNull()
  })

  it("treats a malformed update payload as null", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    emit("update", undefined)
    expect(orch.updateSignal()()).toBeNull()
  })

  // Leak guard: `engine-state` only deletes an entry on an explicit `idle`
  // event, but a task deleted while non-idle (running / error — the common
  // delete case) never emits one. Without snapshot reconciliation a
  // long-lived pane accumulated one stale entry per deleted task, forever.
  it("prunes engine-state entries for tasks absent from a task.snapshot", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)

    const task = (id: string) => ({
      id,
      title: id,
      repo: "/repo",
      branch: id,
      worktreePath: `/wt/${id}`,
      kind: "worktree",
      status: "idle",
      archived: false,
      pinned: false,
      vendor: "claude",
      createdAt: 1,
      updatedAt: 1,
    })

    emit("task.snapshot", { tasks: [task("t1"), task("t2")] })
    emit("engine-state", { taskId: "t1", state: "running", at: 10 })
    emit("engine-state", { taskId: "t2", state: "error", at: 11 })
    expect([...orch.engineStateSignal()().keys()].sort()).toEqual(["t1", "t2"])

    // t2 deleted while in `error` — no idle event will ever arrive for it.
    emit("task.snapshot", { tasks: [task("t1")] })
    const after = orch.engineStateSignal()()
    expect([...after.keys()]).toEqual(["t1"])
    // The surviving entry is untouched (same state, no spurious churn).
    expect(after.get("t1")?.state).toBe("running")

    // A snapshot that changes nothing must not rebuild the map (no
    // re-render storm on every push) — same reference back.
    emit("task.snapshot", { tasks: [task("t1")] })
    expect(orch.engineStateSignal()()).toBe(after)
  })

  // `task.jobs` — long daemon operations (worktree materialisation). The
  // map holds only IN-FLIGHT jobs: `running` adds, the terminal phases
  // remove, so every attached pane can show a "materializing" row while a
  // minutes-long `git worktree add` runs and drop it the moment the
  // blocking RPC settles.
  describe("task.jobs channel", () => {
    const snapshotTask = (id: string) => ({
      id,
      title: id,
      repo: "/repo",
      branch: id,
      worktreePath: `/wt/${id}`,
      kind: "worktree",
      status: "idle",
      archived: false,
      pinned: false,
      vendor: "claude",
      createdAt: 1,
      updatedAt: 1,
    })

    it("tracks running jobs and clears them on done / error", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      expect(orch.taskJobsSignal()().size).toBe(0)

      emit("task.jobs", { taskId: "t1", kind: "ensureWorktree", phase: "running" })
      emit("task.jobs", { taskId: "t2", kind: "ensureWorktree", phase: "running" })
      expect([...orch.taskJobsSignal()().keys()].sort()).toEqual(["t1", "t2"])
      expect(orch.taskJobsSignal()().get("t1")).toEqual({ kind: "ensureWorktree" })

      emit("task.jobs", { taskId: "t1", kind: "ensureWorktree", phase: "done" })
      expect([...orch.taskJobsSignal()().keys()]).toEqual(["t2"])

      // The error terminal phase clears too — the RPC caller gets the real
      // error; the map only answers "is a job in flight".
      emit("task.jobs", { taskId: "t2", kind: "ensureWorktree", phase: "error", error: "boom" })
      expect(orch.taskJobsSignal()().size).toBe(0)
    })

    it("a replayed terminal phase for an untracked task is a true no-op (no map churn)", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      const before = orch.taskJobsSignal()()
      // The bus replays its last `task.jobs` value to a late subscriber; a
      // terminal phase must not rebuild the (empty) map — same ref back.
      emit("task.jobs", { taskId: "t9", kind: "ensureWorktree", phase: "done" })
      expect(orch.taskJobsSignal()()).toBe(before)
    })

    it("ignores malformed payloads", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("task.jobs", undefined)
      emit("task.jobs", { taskId: "t1", kind: "somethingElse", phase: "running" })
      emit("task.jobs", { kind: "ensureWorktree", phase: "running" })
      expect(orch.taskJobsSignal()().size).toBe(0)
    })

    // Leak guard (same contract as engine-state pruning): a task DELETED
    // while its job runs — or a dropped terminal frame across a reconnect —
    // must not pin a phantom "materializing" entry forever. Each
    // task.snapshot reconciles the map against the authoritative task list.
    it("prunes job entries for tasks absent from a task.snapshot", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)

      emit("task.snapshot", { tasks: [snapshotTask("t1"), snapshotTask("t2")] })
      emit("task.jobs", { taskId: "t1", kind: "ensureWorktree", phase: "running" })
      emit("task.jobs", { taskId: "t2", kind: "ensureWorktree", phase: "running" })

      // t2 deleted mid-job — no terminal phase will ever arrive for it here.
      emit("task.snapshot", { tasks: [snapshotTask("t1")] })
      const after = orch.taskJobsSignal()()
      expect([...after.keys()]).toEqual(["t1"])

      // A snapshot that changes nothing must not rebuild the map.
      emit("task.snapshot", { tasks: [snapshotTask("t1")] })
      expect(orch.taskJobsSignal()()).toBe(after)
    })
  })
})
