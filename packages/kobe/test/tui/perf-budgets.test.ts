import { describe, expect, test, vi } from "vitest"
import { computeNextAllowedAt, shouldPoll } from "../../src/lib/poll-scheduling"
import { TASKS_PANE_WIDTH } from "../../src/tmux/session-layout"
import { type Binding, type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap-dispatch"
import { IN_PROGRESS_SPINNER, buildSidebarRowView, withSpinnerFrame } from "../../src/tui/panes/sidebar/row-view"
import {
  MIN_POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  SLOW_REPO_RETRY_MS,
} from "../../src/tui/panes/sidebar/worktree-changes-poller"
import { ensureSession } from "../../src/tui/panes/terminal/tmux"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { CURRENT_VERSION } from "../../src/version"

const tmuxSpy = vi.hoisted(() => ({
  calls: [] as string[],
  observeStdout: "",
  healStdout: "",
}))

vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: () => ["kobe"] }))

vi.mock("../../src/tmux/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client")>()
  const capture = (name: string) => tmuxSpy.calls.push(`capture:${name}`)
  const mutate = (name: string) => tmuxSpy.calls.push(`mutate:${name}`)
  const emptyOptions = (options: readonly string[]) => Object.fromEntries(options.map((o) => [o, undefined]))
  return {
    ...actual,
    sessionExists: async (_name: string) => {
      capture("sessionExists")
      return true
    },
    runTmuxCapturing: async (args: string[]) => {
      const format = args[args.indexOf("-F") + 1] ?? ""
      if (format.includes("@kobe_pane_version")) {
        capture("list-panes:heal-snapshot")
        return { code: 0, stdout: tmuxSpy.healStdout }
      }
      if (format.includes("window_active")) {
        capture("list-panes:observe")
        return { code: 0, stdout: tmuxSpy.observeStdout }
      }
      capture(`runTmuxCapturing:${args[0]}`)
      return { code: 0, stdout: "" }
    },
    runTmuxSequenceCapturing: async () => {
      capture("runTmuxSequenceCapturing")
      return { code: 0, stdout: "" }
    },
    tmuxAvailable: async () => {
      capture("tmuxAvailable")
      return true
    },
    windowCount: async () => {
      capture("windowCount")
      return 1
    },
    getSessionOption: async () => {
      capture("getSessionOption")
      return ""
    },
    getSessionOptions: async (_session: string, options: readonly string[]) => {
      capture("getSessionOptions")
      return emptyOptions(options)
    },
    getServerOption: async () => {
      capture("getServerOption")
      return ""
    },
    getServerOptions: async (options: readonly string[]) => {
      capture("getServerOptions")
      return emptyOptions(options)
    },
    globalTasksPaneWidth: async () => {
      capture("globalTasksPaneWidth")
      return TASKS_PANE_WIDTH
    },
    paneIdByRole: async () => {
      capture("paneIdByRole")
      return ""
    },
    claudePaneId: async () => {
      capture("claudePaneId")
      return ""
    },
    claudePaneIdStrict: async () => {
      capture("claudePaneIdStrict")
      return ""
    },
    capturePaneById: async () => {
      capture("capturePaneById")
      return ""
    },
    currentSessionName: async () => {
      capture("currentSessionName")
      return null
    },
    runTmux: async (args: string[]) => {
      mutate(`runTmux:${args[0]}`)
      return 0
    },
    runTmuxSequence: async () => {
      mutate("runTmuxSequence")
      return 0
    },
    setSessionOption: async () => {
      mutate("setSessionOption")
    },
    setWindowOption: async () => {
      mutate("setWindowOption")
    },
    tagPaneRole: async () => {
      mutate("tagPaneRole")
    },
    tagClaudePane: async () => {
      mutate("tagClaudePane")
    },
    sendKeys: async () => {
      mutate("sendKeys")
    },
    sendKeyName: async () => {
      mutate("sendKeyName")
    },
    newWindow: async () => {
      mutate("newWindow")
    },
    killSession: async () => {
      mutate("killSession")
    },
    ensureFallbackSession: async () => {
      mutate("ensureFallbackSession")
      return "kobe-home"
    },
    switchClientBeforeKill: async () => {
      mutate("switchClientBeforeKill")
    },
  }
})

describe("ensureSession reuse path — tmux invocation budget (fbaa3e0)", () => {
  const cwd = "/wt/perf-budget-task"

  function primeHealthySession(opts: { tasksVersion?: string } = {}): void {
    tmuxSpy.calls.length = 0
    tmuxSpy.observeStdout = [
      `@1\t1\tclaude\t${cwd}\tclaude`,
      `@1\t1\ttasks\t${cwd}\tclaude`,
      `@1\t1\tops\t${cwd}\tclaude`,
    ].join("\n")
    tmuxSpy.healStdout = [
      "@1\t%0\tclaude\t\t120",
      `@1\t%1\ttasks\t${opts.tasksVersion ?? CURRENT_VERSION}\t${TASKS_PANE_WIDTH}`,
      `@1\t%2\tops\t${CURRENT_VERSION}\t60`,
    ].join("\n")
  }

  test("a healthy reuse costs at most 4 tmux invocations and zero mutations", async () => {
    primeHealthySession()
    const ok = await ensureSession({
      name: "kobe-perf-budget-1",
      cwd,
      command: ["claude"],
      vendor: "claude",
      taskId: "perf-budget-task",
    })
    expect(ok).toBe(true)
    expect(tmuxSpy.calls.filter((c) => c.startsWith("mutate:"))).toEqual([])
    expect(tmuxSpy.calls.length).toBeLessThanOrEqual(4)
  })

  test("a stale-pane reuse folds ALL mutations into one tmux invocation (6 total)", async () => {
    primeHealthySession({ tasksVersion: "0.0.0-stale" })
    const ok = await ensureSession({
      name: "kobe-perf-budget-2",
      cwd,
      command: ["claude"],
      vendor: "claude",
      taskId: "perf-budget-task",
    })
    expect(ok).toBe(true)
    expect(tmuxSpy.calls.filter((c) => c.startsWith("mutate:"))).toEqual(["mutate:runTmuxSequence"])
    expect(tmuxSpy.calls.length).toBeLessThanOrEqual(6)
  })
})

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
    live: false,
    spinnerFrame: 0,
    subtitleBudget: 80,
    truncateBranch: (b) => b,
  })
}

describe("idle sidebar tick — frame-accessor read budget (7a4aba5)", () => {
  test("a 20-row idle sidebar performs ZERO frame reads on a tick and keeps every view identity", () => {
    const views = Array.from({ length: 20 }, (_, i) => rowView(`idle-${i}`, false))
    let reads = 0
    const out = views.map((v) =>
      withSpinnerFrame(v, () => {
        reads++
        return 7
      }),
    )
    expect(reads).toBe(0)
    out.forEach((v, i) => expect(v).toBe(views[i]))
  })

  test("a mixed list reads the frame exactly once per LOADING row", () => {
    const views = [
      rowView("idle-a", false),
      rowView("busy-a", true),
      rowView("idle-b", false),
      rowView("busy-b", true),
      rowView("idle-c", false),
    ]
    let reads = 0
    const out = views.map((v) =>
      withSpinnerFrame(v, () => {
        reads++
        return 3
      }),
    )
    expect(reads).toBe(2)
    expect(out[0]).toBe(views[0])
    expect(out[2]).toBe(views[2])
    expect(out[4]).toBe(views[4])
    expect(out[1]?.stateGlyph).toBe(IN_PROGRESS_SPINNER[3])
    expect(out[3]?.stateGlyph).toBe(IN_PROGRESS_SPINNER[3])
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

describe("keymap dispatch — binding-stack walk budget", () => {
  test("a hit in the TOP group reads exactly one group config (short-circuit on hit)", () => {
    let reads = 0
    let fires = 0
    const stack = Array.from({ length: 25 }, (_, i) =>
      layer(
        `f${i + 1}`,
        () => reads++,
        () => fires++,
      ),
    )
    expect(dispatchKeyEvent(stack, keyEvent("f25"))).toBe(true)
    expect(fires).toBe(1)
    expect(reads).toBe(1)
  })

  test("a miss reads each of the 25 group configs exactly once (no re-walk)", () => {
    let reads = 0
    const stack = Array.from({ length: 25 }, (_, i) => layer(`f${i + 1}`, () => reads++))
    expect(dispatchKeyEvent(stack, keyEvent("z"))).toBe(false)
    expect(reads).toBe(25)
  })
})

function stormRuns(opts: { ticks: number; tickMs: number; runDurationMs: number; timedOut: boolean }): number {
  const cfg = { slowRetryMs: SLOW_REPO_RETRY_MS, minIntervalMs: MIN_POLL_INTERVAL_MS }
  const state = { inFlight: false, nextAllowedAt: 0 }
  let inFlight: { startedAt: number; finishedAt: number } | null = null
  let runs = 0
  for (let i = 0; i < opts.ticks; i++) {
    const now = i * opts.tickMs
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

describe("worktree-changes scheduling — runs allowed under a 100-tick storm (320919a)", () => {
  const TICKS = 100
  const TICK_MS = 2_000

  test("a slow-but-finishing repo (3s status) self-thins to exactly 12 runs", () => {
    expect(stormRuns({ ticks: TICKS, tickMs: TICK_MS, runDurationMs: 3_000, timedOut: false })).toBe(12)
  })

  test("a repo that always times out backs off to exactly 4 runs", () => {
    expect(stormRuns({ ticks: TICKS, tickMs: TICK_MS, runDurationMs: POLL_TIMEOUT_MS, timedOut: true })).toBe(4)
  })

  test("a fast repo (50ms status) keeps the tick cadence — every tick runs, never more", () => {
    expect(stormRuns({ ticks: TICKS, tickMs: TICK_MS, runDurationMs: 50, timedOut: false })).toBe(TICKS)
  })
})
