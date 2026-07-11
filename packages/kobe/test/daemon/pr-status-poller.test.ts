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
  DEFAULT_PR_STATUS_POLL_MS,
  NO_PR_BACKOFF_MS,
  NO_REMOTE_BACKOFF_MS,
  PR_FAILURE_BASE_MS,
  type PrPollSchedule,
  type PrStatusPassOptions,
  type PrViewResult,
  type PrViewRunner,
  SETTLED_BACKOFF_MS,
  isPrPollable,
  pickPr,
  runPrStatusPass as runPrStatusPassRaw,
} from "@sma1lboy/kobe-daemon/daemon/pr-status-collector"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { daemonRuntime } from "../../src/core/daemon-runtime.ts"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { type Task, toTaskId } from "../../src/types/task.ts"

const runPrStatusPass = (orchestrator: Orchestrator, options: Omit<PrStatusPassOptions, "runtime">) =>
  runPrStatusPassRaw(orchestrator, { ...options, runtime: daemonRuntime })

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

/** Cancel jitter (rand 0.5 → no offset) so the scheduled delays are exact. */
const noJitter = (): number => 0.5

describe("pickPr", () => {
  test("empty list → undefined (no PR)", () => {
    expect(pickPr([])).toBeUndefined()
  })
  test("an open PR wins over a merged/closed one, regardless of order", () => {
    const open = { number: 2, state: "OPEN" }
    const merged = { number: 1, state: "MERGED" }
    expect(pickPr([merged, open])).toBe(open)
    expect(pickPr([open, merged])).toBe(open)
  })
  test("merged vs closed ties keep the first (list order = most-recently-updated)", () => {
    const merged = { number: 1, state: "MERGED" }
    const closed = { number: 2, state: "CLOSED" }
    expect(pickPr([merged, closed])).toBe(merged)
  })
})

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
      rand: noJitter,
    })
    expect(changed).toEqual([id])
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("passing")
    expect(orch.getTask(id)?.prStatus?.lifecycle).toBe("open")
  })

  test("a second pass with the same status reports no change (samePrStatus)", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    await runPrStatusPass(orch, { run: prRunner("OPEN", "SUCCESS"), now: 0, at: "t1", schedule, rand: noJitter })
    // Advance past the backoff so the task is due again.
    const changed = await runPrStatusPass(orch, {
      run: prRunner("OPEN", "SUCCESS"),
      now: 10_000_000,
      at: "t2",
      schedule,
      rand: noJitter,
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
    await runPrStatusPass(orch, { run: counting, now: 1_000, at: "t1", schedule, tickMs: 30_000, rand: noJitter })
    expect(calls).toBe(1)
    // Immediately again — still inside the 30s backoff window → skipped.
    await runPrStatusPass(orch, { run: counting, now: 5_000, at: "t2", schedule, tickMs: 30_000, rand: noJitter })
    expect(calls).toBe(1)
    // Past the window → polled again.
    await runPrStatusPass(orch, { run: counting, now: 40_000, at: "t3", schedule, tickMs: 30_000, rand: noJitter })
    expect(calls).toBe(2)
    expect(id).toBeTruthy()
  })

  test("empty result keeps the last value and applies the no-PR backoff", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    await runPrStatusPass(orch, { run: prRunner("OPEN", "FAILURE"), now: 0, at: "t1", schedule, rand: noJitter })
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("failing")
    // gh ran but the branch has no PR — must NOT clear the known status.
    await runPrStatusPass(orch, { run: emptyRunner, now: 10_000_000, at: "t2", schedule, rand: noJitter })
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("failing")
    expect(schedule.get(id)?.nextAllowedAt).toBe(10_000_000 + NO_PR_BACKOFF_MS)
  })

  test("a merged PR gets the long settled backoff", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    await runPrStatusPass(orch, {
      run: prRunner("MERGED", "SUCCESS"),
      now: 0,
      at: "t1",
      schedule,
      tickMs: 30_000,
      rand: noJitter,
    })
    expect(orch.getTask(id)?.prStatus?.lifecycle).toBe("merged")
    expect(schedule.get(id)?.nextAllowedAt).toBe(0 + SETTLED_BACKOFF_MS)
  })

  test("skips archived tasks and forgets their backoff", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map([[id, { nextAllowedAt: 0, failures: 0 }]])
    await store.update(id, { archived: true })
    const changed = await runPrStatusPass(orch, {
      run: prRunner("OPEN", "SUCCESS"),
      now: 1_000,
      at: "t1",
      schedule,
      rand: noJitter,
    })
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

  test("a gh ERROR keeps the last status and backs off exponentially (not as 'no PR')", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    // Seed a known-good chip.
    await runPrStatusPass(orch, { run: prRunner("OPEN", "SUCCESS"), now: 0, at: "t1", schedule, rand: noJitter })
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("passing")

    const authError: PrViewRunner = async () => ({ kind: "error", error: "auth" })
    // First failure: keep the chip, back off by the base interval, streak = 1.
    await runPrStatusPass(orch, { run: authError, now: 10_000_000, at: "t2", schedule, rand: noJitter })
    expect(orch.getTask(id)?.prStatus?.checkState).toBe("passing") // NOT cleared
    expect(schedule.get(id)?.failures).toBe(1)
    expect(schedule.get(id)?.nextAllowedAt).toBe(10_000_000 + PR_FAILURE_BASE_MS)

    // Second consecutive failure: streak = 2, backoff doubles.
    const due = schedule.get(id)?.nextAllowedAt ?? 0
    await runPrStatusPass(orch, { run: authError, now: due, at: "t3", schedule, rand: noJitter })
    expect(schedule.get(id)?.failures).toBe(2)
    expect(schedule.get(id)?.nextAllowedAt).toBe(due + PR_FAILURE_BASE_MS * 2)
  })

  test("a success after failures resets the backoff streak", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    const netError: PrViewRunner = async () => ({ kind: "error", error: "network" })
    await runPrStatusPass(orch, { run: netError, now: 0, at: "t1", schedule, rand: noJitter })
    expect(schedule.get(id)?.failures).toBe(1)
    const due = schedule.get(id)?.nextAllowedAt ?? 0
    await runPrStatusPass(orch, { run: prRunner("OPEN", "SUCCESS"), now: due, at: "t2", schedule, rand: noJitter })
    expect(schedule.get(id)?.failures).toBe(0)
    expect(schedule.get(id)?.nextAllowedAt).toBe(due + DEFAULT_PR_STATUS_POLL_MS)
  })

  test("no-remote settles to the long idle cadence with no failure streak", async () => {
    const id = await makeTask()
    const schedule: PrPollSchedule = new Map()
    const noRemote: PrViewRunner = async () => ({ kind: "error", error: "no-remote" })
    await runPrStatusPass(orch, { run: noRemote, now: 1_000, at: "t1", schedule, rand: noJitter })
    expect(schedule.get(id)?.failures).toBe(0)
    expect(schedule.get(id)?.nextAllowedAt).toBe(1_000 + NO_REMOTE_BACKOFF_MS)
    expect(orch.getTask(id)?.prStatus).toBeUndefined()
  })
})
