/**
 * Deterministic operation-count performance budgets for retained PureTUI
 * hot paths. Wall-clock benchmarks remain local and opt-in.
 */

import { describe, expect, test } from "vitest"
import { computeNextAllowedAt, shouldPoll } from "../../src/lib/poll-scheduling"
import { type Binding, type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap-dispatch"
import { buildSidebarRowView, withSpinnerFrame } from "../../src/tui/panes/sidebar/row-view"
import {
  MIN_POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  SLOW_REPO_RETRY_MS,
} from "../../src/tui/panes/sidebar/worktree-changes-poller"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"

function task(overrides: Omit<Partial<Task>, "id"> & { id?: string } = {}): Task {
  return {
    id: toTaskId(overrides.id ?? "task-1"),
    title: "fix sidebar",
    repo: "/repo/kobe",
    branch: "feature/sidebar",
    worktreePath: "/repo/kobe/worktrees/sidebar",
    kind: "task",
    status: "backlog",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task
}

function rowView(id: string, running: boolean) {
  return buildSidebarRowView({
    task: task({ id, status: running ? "in_progress" : "done" }),
    activity: running ? { state: "running", at: 1 } : { state: "turn_complete", at: 1 },
    spinnerFrame: 0,
    subtitleBudget: 80,
    truncateBranch: (branch) => branch,
  })
}

describe("idle sidebar tick frame-accessor budget", () => {
  test("20 idle rows perform zero frame reads and preserve identity", () => {
    const views = Array.from({ length: 20 }, (_, index) => rowView(`idle-${index}`, false))
    let reads = 0
    const out = views.map((view) =>
      withSpinnerFrame(view, () => {
        reads++
        return 7
      }),
    )
    expect(reads).toBe(0)
    out.forEach((view, index) => expect(view).toBe(views[index]))
  })

  test("mixed rows read the frame once per loading row", () => {
    const views = [
      rowView("idle-a", false),
      rowView("busy-a", true),
      rowView("idle-b", false),
      rowView("busy-b", true),
      rowView("idle-c", false),
    ]
    let reads = 0
    const out = views.map((view) =>
      withSpinnerFrame(view, () => {
        reads++
        return 3
      }),
    )
    expect(reads).toBe(2)
    expect(out[0]).toBe(views[0])
    expect(out[2]).toBe(views[2])
    expect(out[4]).toBe(views[4])
    expect(out[1]?.stateGlyph).toBe(views[1]?.spinnerFrames[3])
    expect(out[3]?.stateGlyph).toBe(views[3]?.spinnerFrames[3])
  })
})

let nextLayerId = 0
function layer(key: string, onRead: () => void, fired?: () => void): RegisteredBinding {
  const bindings: Binding[] = [
    { key, cmd: () => fired?.() },
    { key: `alt+${key}`, cmd: () => fired?.() },
  ]
  return {
    id: ++nextLayerId,
    config: () => {
      onRead()
      return { bindings }
    },
  }
}

function keyEvent(name: string) {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    name,
  }
}

describe("keymap dispatch binding-stack budget", () => {
  test("a top-group hit reads one config", () => {
    let reads = 0
    let fires = 0
    const stack = Array.from({ length: 25 }, (_, index) =>
      layer(
        `f${index + 1}`,
        () => reads++,
        () => fires++,
      ),
    )
    expect(dispatchKeyEvent(stack, keyEvent("f25"))).toBe(true)
    expect(fires).toBe(1)
    expect(reads).toBe(1)
  })

  test("a miss reads each config once", () => {
    let reads = 0
    const stack = Array.from({ length: 25 }, (_, index) => layer(`f${index + 1}`, () => reads++))
    expect(dispatchKeyEvent(stack, keyEvent("z"))).toBe(false)
    expect(reads).toBe(25)
  })
})

function stormRuns(opts: { ticks: number; tickMs: number; runDurationMs: number; timedOut: boolean }): number {
  const cfg = { slowRetryMs: SLOW_REPO_RETRY_MS, minIntervalMs: MIN_POLL_INTERVAL_MS }
  const state = { inFlight: false, nextAllowedAt: 0 }
  let inFlight: { startedAt: number; finishedAt: number } | null = null
  let runs = 0
  for (let index = 0; index < opts.ticks; index++) {
    const now = index * opts.tickMs
    if (inFlight && inFlight.finishedAt <= now) {
      state.nextAllowedAt = computeNextAllowedAt(inFlight.startedAt, inFlight.finishedAt, opts.timedOut, cfg)
      state.inFlight = false
      inFlight = null
    }
    if (shouldPoll(state, now)) {
      runs++
      state.inFlight = true
      inFlight = { startedAt: now, finishedAt: now + opts.runDurationMs }
    }
  }
  return runs
}

describe("worktree-changes scheduling under a 100-tick storm", () => {
  const ticks = 100
  const tickMs = 2_000

  test("slow-but-finishing repo self-thins to 12 runs", () => {
    expect(stormRuns({ ticks, tickMs, runDurationMs: 3_000, timedOut: false })).toBe(12)
  })

  test("a timing-out repo backs off to four runs", () => {
    expect(stormRuns({ ticks, tickMs, runDurationMs: POLL_TIMEOUT_MS, timedOut: true })).toBe(4)
  })

  test("a fast repo stays at one run per tick", () => {
    expect(stormRuns({ ticks, tickMs, runDurationMs: 50, timedOut: false })).toBe(ticks)
  })
})
