/**
 * PR-status poller (KOB-10). Drives the pass logic against a REAL Orchestrator
 * + on-disk store with an injected `gh pr view` runner, so the seams under
 * test are: eligibility filtering, write-on-change + samePrStatus diffing,
 * keep-last on `empty`, and the per-task backoff schedule.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  NO_PR_BACKOFF_MS,
  type PrPollSchedule,
  type PrViewResult,
  type PrViewRunner,
  SETTLED_BACKOFF_MS,
  isPrPollable,
  runPrStatusPass,
} from "@sma1lboy/kobe-daemon/daemon/pr-status-collector"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { type Task, toTaskId } from "../../src/types/task.ts"

let tmpRoot: string
let store: TaskIndexStore
let orch: Orchestrator

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-prstatus-"))
  store = new TaskIndexStore({ homeDir: path.join(tmpRoot, "home") })
  await store.load()
  orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

async function makeTask(opts: { worktree?: string } = {}): Promise<string> {
  const task = await orch.createTask({ repo: "/repo" })
  // A backlog task has no branch until its worktree is materialized; stamp one
  // (plus a worktree path) so it clears the pr-pollable gate.
  await store.update(task.id, { worktreePath: opts.worktree ?? `/wt/${task.id}`, branch: `kobe/test-${task.id}` })
  return task.id
}

/** A runner that returns a fixed PR view (open, with one check in `state`). */
function prRunner(state: string, checkConclusion: string): PrViewRunner {
  return async (): Promise<PrViewResult> => ({
    kind: "pr",
    view: {
      number: 7,
      state,
      statusCheckRollup: [{ status: "COMPLETED", conclusion: checkConclusion }],
    },
  })
}

const emptyRunner: PrViewRunner = async () => ({ kind: "empty" })

describe("isPrPollable", () => {
  const base: Task = {
    id: toTaskId("t1"),
    title: "x",
    repo: "/repo",
    branch: "kobe/x-1",
    worktreePath: "/wt/x",
    status: "backlog",
    archived: false,
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  }
  test("a regular task with a branch + local worktree is pollable", () => {
    expect(isPrPollable(base)).toBe(true)
  })
  test("archived / main / no-branch / no-worktree are not", () => {
    expect(isPrPollable({ ...base, archived: true })).toBe(false)
    expect(isPrPollable({ ...base, kind: "main", branch: "" })).toBe(false)
    expect(isPrPollable({ ...base, branch: "" })).toBe(false)
    expect(isPrPollable({ ...base, worktreePath: "" })).toBe(false)
  })
  test("remote (ssh://) projects are skipped", () => {
    expect(isPrPollable({ ...base, repo: "ssh://host/repo" })).toBe(false)
  })
})

describe("runPrStatusPass", () => {
  test("writes a mapped status for an eligible task and reports it changed", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    const changed = await runPrStatusPass(orch, {
      run: prRunner("OPEN", "SUCCESS"),
      now: 1_000,
      at: "2026-06-24T00:00:00.000Z",
      schedule,
    })
    expect(changed).toEqual([id])
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("passing")
    expect(orch.getTask(id)?.prStatus?.lifecycle).toBe("open")
  })

  test("a second pass with the same status reports no change (samePrStatus)", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    await runPrStatusPass(orch, { run: prRunner("OPEN", "SUCCESS"), now: 0, at: "t1", schedule })
    // Advance past the backoff so the task is due again.
    const changed = await runPrStatusPass(orch, {
      run: prRunner("OPEN", "SUCCESS"),
      now: 10_000_000,
      at: "t2",
      schedule,
    })
    expect(changed).toEqual([])
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("passing")
  })

  test("backoff: a task is not re-polled until its scheduled time", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    let calls = 0
    const counting: PrViewRunner = async () => {
      calls++
      return { kind: "pr", view: { number: 7, state: "OPEN", statusCheckRollup: [{ state: "PENDING" }] } }
    }
    await runPrStatusPass(orch, { run: counting, now: 1_000, at: "t1", schedule, tickMs: 30_000 })
    expect(calls).toBe(1)
    // Immediately again — still inside the 30s backoff window → skipped.
    await runPrStatusPass(orch, { run: counting, now: 5_000, at: "t2", schedule, tickMs: 30_000 })
    expect(calls).toBe(1)
    // Past the window → polled again.
    await runPrStatusPass(orch, { run: counting, now: 40_000, at: "t3", schedule, tickMs: 30_000 })
    expect(calls).toBe(2)
    expect(id).toBeTruthy()
  })

  test("empty result keeps the last value and applies the no-PR backoff", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    await runPrStatusPass(orch, { run: prRunner("OPEN", "FAILURE"), now: 0, at: "t1", schedule })
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("failing")
    // gh now returns nothing usable — must NOT clear the known status.
    await runPrStatusPass(orch, { run: emptyRunner, now: 10_000_000, at: "t2", schedule })
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("failing")
    expect(schedule.get(id)).toBe(10_000_000 + NO_PR_BACKOFF_MS)
  })

  test("a merged PR gets the long settled backoff", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    await runPrStatusPass(orch, { run: prRunner("MERGED", "SUCCESS"), now: 0, at: "t1", schedule, tickMs: 30_000 })
    expect(orch.getTask(id)?.prStatus?.lifecycle).toBe("merged")
    expect(schedule.get(id)).toBe(0 + SETTLED_BACKOFF_MS)
  })

  test("skips archived tasks and forgets their backoff", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map([[id, 0]])
    await store.update(id, { archived: true })
    const changed = await runPrStatusPass(orch, { run: prRunner("OPEN", "SUCCESS"), now: 1_000, at: "t1", schedule })
    expect(changed).toEqual([])
    expect(schedule.has(id)).toBe(false)
  })

  test("a throwing runner does not block the other tasks", async () => {
    const boom = await makeTask({ worktree: "/wt/boom" })
    const ok = await makeTask({ worktree: "/wt/ok" })
    const schedule: PrPollSchedule = new Map()
    const changed = await runPrStatusPass(orch, {
      run: async (wt: string) => {
        if (wt === "/wt/boom") throw new Error("gh blew up")
        return { kind: "pr", view: { number: 7, state: "OPEN", statusCheckRollup: [{ state: "SUCCESS" }] } }
      },
      now: 0,
      at: "t1",
      schedule,
    })
    expect(changed).toEqual([ok])
    expect(orch.getTask(boom)?.prStatus).toBeUndefined()
    expect(orch.getTask(ok)?.prStatus?.checkState).toBe("passing")
  })
})
