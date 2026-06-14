import { describe, expect, it } from "vitest"
import {
  applyJobEvent,
  isOrphanIdleEngineState,
} from "../src/lib/store.ts"
import type { Task, TaskJob } from "../src/lib/types.ts"

/**
 * The two decision points inside applyEvent, extracted as pure helpers so the
 * bugs they encode stay fixed:
 *  - isOrphanIdleEngineState: a delete emits task.snapshot (task gone) then a
 *    trailing idle engine-state for the same id; that orphan must be dropped,
 *    but a NON-idle state for an unknown task is a mid-creation race and kept.
 *  - applyJobEvent: a running job is tracked by taskId; any terminal phase
 *    clears it, so a finished worktree-materialize spinner can't linger.
 */

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
