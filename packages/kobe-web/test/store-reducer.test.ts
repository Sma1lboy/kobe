import { describe, expect, it } from "vitest"
import {
  applyJobEvent,
  isOrphanIdleEngineState,
  reconnectDelay,
  validateSnapshot,
} from "../src/lib/store.ts"
import type { Task, TaskJob, WebTransportSnapshot } from "../src/lib/types.ts"


const task = (id: string): Task => ({ id }) as Task
const job = (taskId: string, phase: TaskJob["phase"]): TaskJob => ({
  taskId,
  kind: "worktree",
  phase,
})

describe("isOrphanIdleEngineState", () => {
  it("is an orphan when the task is gone and the state is idle", () => {
    expect(isOrphanIdleEngineState(undefined, "idle")).toBe(true)
  })

  it("is NOT an orphan when the task still exists (idle is real)", () => {
    expect(isOrphanIdleEngineState(task("t1"), "idle")).toBe(false)
  })

  it("keeps a non-idle state for an unknown task (mid-creation race)", () => {
    expect(isOrphanIdleEngineState(undefined, "running")).toBe(false)
    expect(isOrphanIdleEngineState(undefined, "waiting_permission")).toBe(false)
    expect(isOrphanIdleEngineState(undefined, "error")).toBe(false)
  })

  it("keeps every state for an existing task", () => {
    expect(isOrphanIdleEngineState(task("t1"), "running")).toBe(false)
    expect(isOrphanIdleEngineState(task("t1"), "error")).toBe(false)
  })
})

describe("applyJobEvent", () => {
  it("tracks a running job by taskId", () => {
    const out = applyJobEvent({}, job("t1", "running"))
    expect(out).toEqual({ t1: job("t1", "running") })
  })

  it("replaces an earlier running job for the same task", () => {
    const first = applyJobEvent({}, job("t1", "running"))
    const second = applyJobEvent(first, job("t1", "running"))
    expect(Object.keys(second)).toEqual(["t1"])
  })

  it("clears the entry when the job is done", () => {
    const running = applyJobEvent({}, job("t1", "running"))
    expect(applyJobEvent(running, job("t1", "done"))).toEqual({})
  })

  it("clears the entry when the job errors", () => {
    const running = applyJobEvent({}, job("t1", "running"))
    expect(applyJobEvent(running, job("t1", "error"))).toEqual({})
  })

  it("leaves other tasks' jobs untouched on a terminal phase", () => {
    const two = applyJobEvent(
      applyJobEvent({}, job("t1", "running")),
      job("t2", "running"),
    )
    expect(applyJobEvent(two, job("t1", "done"))).toEqual({
      t2: job("t2", "running"),
    })
  })

  it("does not mutate the input map (running insert)", () => {
    const before: Record<string, TaskJob> = {}
    applyJobEvent(before, job("t1", "running"))
    expect(before).toEqual({})
  })

  it("does not mutate the input map (terminal clear)", () => {
    const before = applyJobEvent({}, job("t1", "running"))
    const snapshot = { ...before }
    applyJobEvent(before, job("t1", "done"))
    expect(before).toEqual(snapshot)
  })
})

describe("validateSnapshot", () => {
  const ok: WebTransportSnapshot = {
    tasks: [],
    activeTaskId: null,
    engineStates: {},
    update: null,
    connected: true,
  }

  it("accepts a well-formed minimal snapshot", () => {
    expect(validateSnapshot(ok)).toBe(ok)
  })

  it("accepts a populated snapshot with optional maps", () => {
    const full = {
      ...ok,
      activeTaskId: "t1",
      jobs: {},
      worktreeChanges: {},
      issueSnapshots: {},
      uiPrefs: { theme: "claude" },
    }
    expect(validateSnapshot(full)).toBe(full)
  })

  it("rejects a non-object frame", () => {
    expect(validateSnapshot(null)).toBeNull()
    expect(validateSnapshot("nope")).toBeNull()
    expect(validateSnapshot(42)).toBeNull()
    expect(validateSnapshot([])).toBeNull()
  })

  it("rejects when tasks is not an array (the crash the guard prevents)", () => {
    expect(validateSnapshot({ ...ok, tasks: {} })).toBeNull()
    expect(validateSnapshot({ ...ok, tasks: "x" })).toBeNull()
    const { tasks: _drop, ...noTasks } = ok
    expect(validateSnapshot(noTasks)).toBeNull()
  })

  it("rejects a bad activeTaskId type", () => {
    expect(validateSnapshot({ ...ok, activeTaskId: 7 })).toBeNull()
  })

  it("rejects when engineStates is missing or not an object", () => {
    expect(validateSnapshot({ ...ok, engineStates: [] })).toBeNull()
    expect(validateSnapshot({ ...ok, engineStates: null })).toBeNull()
  })

  it("rejects a non-boolean connected flag", () => {
    expect(validateSnapshot({ ...ok, connected: "yes" })).toBeNull()
  })

  it("rejects a present-but-wrong optional map", () => {
    expect(validateSnapshot({ ...ok, jobs: [] })).toBeNull()
    expect(validateSnapshot({ ...ok, worktreeChanges: 1 })).toBeNull()
    expect(validateSnapshot({ ...ok, issueSnapshots: "x" })).toBeNull()
    expect(validateSnapshot({ ...ok, uiPrefs: 5 })).toBeNull()
  })

  it("allows null uiPrefs (a disconnected snapshot carries no prefs)", () => {
    const snap = { ...ok, uiPrefs: null }
    expect(validateSnapshot(snap)).toBe(snap)
  })
})

describe("reconnectDelay", () => {
  it("backs off exponentially from 500ms", () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(1)).toBe(1000)
    expect(reconnectDelay(2)).toBe(2000)
    expect(reconnectDelay(3)).toBe(4000)
  })

  it("caps at 10s no matter how many attempts", () => {
    expect(reconnectDelay(5)).toBe(10_000)
    expect(reconnectDelay(50)).toBe(10_000)
  })

  it("treats negative attempts as the first retry", () => {
    expect(reconnectDelay(-3)).toBe(500)
  })
})
