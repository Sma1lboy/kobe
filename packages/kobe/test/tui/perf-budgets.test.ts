/**
 * Performance-budget regression net — OPERATION COUNTS, never wall-clock.
 *
 * Each test pins the operation-count contract a specific perf commit
 * established, using counting fakes / module mocks at the same seams the
 * production code injects. Deterministic and CI-safe: if one of these
 * fails, a hot path regressed to doing per-tick / per-switch work that
 * was deliberately removed — the UI would still look identical, which is
 * exactly why a counting test (not eyeballing) has to hold the line.
 *
 * Budgets pinned here, by commit:
 *
 *   - `fbaa3e0` (perf: tmux+engine — batch the session hot paths):
 *     ensureSession's REUSE path runs on every task switch and was
 *     batched from 10 tmux spawns down to 4 (observe = existence probe +
 *     ONE list-panes; heal = ONE batched option read + ONE list-panes
 *     snapshot; all mutations folded into ONE sequence, zero on healthy).
 *   - `7a4aba5` (perf: tui — idle ticks stop doing real work): the
 *     sidebar's 10Hz spinner tick is a CONDITIONAL dependency — the
 *     frame accessor is read once per loading row and never for idle
 *     rows, so an idle sidebar does zero per-tick work.
 *   - `320919a` + the 30GB-repo freeze fix (poll-scheduling guards): a
 *     tick storm against a slow/huge repo starts a bounded number of
 *     `git status` runs, not one per tick.
 *
 * Related counting tests that already pin sibling budgets (not
 * duplicated here): test/tui/git-head-poller.test.ts (spawns per branch
 * resolve), test/engine/turn-detector.test.ts (transcript reads per
 * poll), test/tui/filetree-rows.test.ts + sidebar-groups.test.ts (row
 * identity reuse), test/tmux/chat-tab-naming.test.ts (spawns per naming
 * sweep).
 *
 * NO timing assertions in this file — wall-clock benchmarks live in
 * test/bench/*.bench.ts (local, opt-in, never a gate; docs/HARNESS.md).
 */

import { describe, expect, test, vi } from "vitest"
import { computeNextAllowedAt, shouldPoll } from "../../src/lib/poll-scheduling"
import { TASKS_PANE_WIDTH } from "../../src/tmux/session-layout"
import { type Binding, type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap-dispatch"
import { buildSidebarRowView, withSpinnerFrame } from "../../src/tui/panes/sidebar/row-view"
import {
  MIN_POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  SLOW_REPO_RETRY_MS,
} from "../../src/tui/panes/sidebar/worktree-changes-poller"
import { ensureSession } from "../../src/tui/panes/terminal/tmux"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { CURRENT_VERSION } from "../../src/version"

/* ------------------------------------------------------------------ */
/*  (a) ensureSession REUSE path — tmux invocation budget (fbaa3e0)    */
/* ------------------------------------------------------------------ */

/**
 * Every exported tmux-client function that spawns a tmux process is
 * replaced with a recorder, so the counter below IS the spawn count —
 * a regression that reaches for any client helper (even one this path
 * never used before) shows up in `calls` instead of silently spawning.
 * Read-only helpers record `capture:*`; anything that mutates server
 * state records `mutate:*`.
 */
const tmuxSpy = vi.hoisted(() => ({
  calls: [] as string[],
  /** Canned `list-panes -s -F OBSERVE_SESSION_FORMAT` stdout. */
  observeStdout: "",
  /** Canned `list-panes -s -F KOBE_PANE_LIST_FORMAT` stdout. */
  healStdout: "",
}))

// Not a counted operation — pure environment introspection. The real
// implementation uses `import.meta.resolve` (unsupported under vitest's
// SSR transform) and runs even on a zero-target heal, so it needs a stub
// for the reuse path to execute at all.
vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: () => ["kobe"] }))

vi.mock("../../src/tmux/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client")>()
  const capture = (name: string) => tmuxSpy.calls.push(`capture:${name}`)
  const mutate = (name: string) => tmuxSpy.calls.push(`mutate:${name}`)
  const emptyOptions = (options: readonly string[]) => Object.fromEntries(options.map((o) => [o, undefined]))
  return {
    ...actual,
    // -- read-only spawns ------------------------------------------------
    sessionExists: async (_name: string) => {
      capture("sessionExists")
      return true
    },
    runTmuxCapturing: async (args: string[]) => {
      // Discriminate the two one-spawn listings by their `-F` format. The
      // markers are stable fragments of OBSERVE_SESSION_FORMAT (tmux.ts)
      // and KOBE_PANE_LIST_FORMAT (pane-heal.ts).
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
    // -- mutating spawns (a HEALTHY reuse must issue NONE) ----------------
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
    // Observe answer: active window has a live claude pane, worktree +
    // vendor tags match the target → decideSessionAction says "reuse".
    tmuxSpy.observeStdout = [
      `@1\t1\tclaude\t${cwd}\tclaude`,
      `@1\t1\ttasks\t${cwd}\tclaude`,
      `@1\t1\tops\t${cwd}\tclaude`,
    ].join("\n")
    // Heal snapshot: rail already at the global width, kobe-owned panes
    // already on the current version → zero resize/respawn commands.
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
    // The batching contract: existence probe + ONE observe listing + ONE
    // batched server-option read + ONE heal snapshot. Spawn #5 means an
    // un-batched read crept back into the every-task-switch path.
    expect(tmuxSpy.calls.filter((c) => c.startsWith("mutate:"))).toEqual([])
    expect(tmuxSpy.calls.length).toBeLessThanOrEqual(4)
  })

  test("a stale-pane reuse folds ALL mutations into one tmux invocation (6 total)", async () => {
    // Same healthy session, but the Tasks pane was spawned by an older
    // kobe — the heal must respawn it, and the batching contract says
    // every mutation (respawn + role/version re-tag) rides ONE sequence.
    //
    // Budget is 6, not 5: when (and only when) the heal has mutations to run,
    // it re-lists panes once immediately before the batch and drops commands
    // for any pane that vanished since the heal snapshot, so one since-closed
    // pane can't abort the respawn of the others (tmux halts a `cmd ; cmd …`
    // sequence on the first failed respawn). The HEALTHY reuse above — the true
    // every-switch hot path — has no commands, so it never pays this read and
    // its 4-invocation budget is unchanged.
    // The pre-exec re-validation read returns the SAME heal snapshot (the mock
    // routes every heal-format list-panes to `healStdout`), so no command is
    // dropped and the full respawn batch still runs — it just costs one read.
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

/* ------------------------------------------------------------------ */
/*  (b) Idle sidebar tick — frame-accessor read budget (7a4aba5)       */
/* ------------------------------------------------------------------ */

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
  // The Sidebar applies `withSpinnerFrame(baseRowView(), spinnerFrame)`
  // inside a per-row memo: reading the 10Hz frame signal is what
  // subscribes a row to the tick. The budget is therefore "frame reads
  // per tick == number of LOADING rows" — an idle sidebar must do zero
  // per-tick work (before 7a4aba5: 20 idle tasks = 200 full view
  // rebuilds per second). sidebar-row-view.test.ts pins the single-row
  // contract; this is the whole-list budget.
  test("a 20-row idle sidebar performs ZERO frame reads on a tick and keeps every view identity", () => {
    const views = Array.from({ length: 20 }, (_, i) => rowView(`idle-${i}`, false))
    let reads = 0
    const out = views.map((v) =>
      withSpinnerFrame(v, () => {
        reads++
        return 7
      }),
    )
    expect(reads).toBe(0) // the tick has zero subscribers when nothing spins
    out.forEach((v, i) => expect(v).toBe(views[i])) // identity → memos never notify
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
    expect(reads).toBe(2) // exactly the two loading rows — never the idle ones
    expect(out[0]).toBe(views[0])
    expect(out[2]).toBe(views[2])
    expect(out[4]).toBe(views[4])
    // Glyphs come from each view's OWN engine frame set (claude stars here).
    expect(out[1]?.stateGlyph).toBe(views[1]?.spinnerFrames[3])
    expect(out[3]?.stateGlyph).toBe(views[3]?.spinnerFrames[3])
  })
})

/* ------------------------------------------------------------------ */
/*  (c) Keymap dispatch — binding-stack walk budget                    */
/* ------------------------------------------------------------------ */

// NOTE on scope: 7a4aba5 also made `findBinding` an O(1) map lookup
// (KEYMAP_BY_ID in context/keybindings.ts). That map is module-private
// with no injection seam, so "no full-table scan" is NOT observable from
// outside and is deliberately NOT asserted here — a fake assertion would
// pin nothing. What IS observable is the dispatch walk itself: each
// registered group's `config()` is a Solid signal read in production, so
// the per-keypress budget is "config reads per dispatch".

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
    // 25 groups ≈ a realistic stack (global chords + pane groups + dialog).
    // The stack is walked top-down (last registered first); group 24 is top.
    const stack = Array.from({ length: 25 }, (_, i) =>
      layer(
        `f${i + 1}`,
        () => reads++,
        () => fires++,
      ),
    )
    expect(dispatchKeyEvent(stack, keyEvent("f25"))).toBe(true)
    expect(fires).toBe(1)
    expect(reads).toBe(1) // lower 24 groups never consulted after the hit
  })

  test("a miss reads each of the 25 group configs exactly once (no re-walk)", () => {
    let reads = 0
    const stack = Array.from({ length: 25 }, (_, i) => layer(`f${i + 1}`, () => reads++))
    expect(dispatchKeyEvent(stack, keyEvent("z"))).toBe(false)
    expect(reads).toBe(25)
  })
})

/* ------------------------------------------------------------------ */
/*  (d) worktree-changes scheduling — runs-per-storm budget (320919a)  */
/* ------------------------------------------------------------------ */

/**
 * Drive the pure scheduling guards through a simulated tick storm in
 * virtual time. This is exactly the state machine both bindings run —
 * the TUI poller (background-poll.ts) and the daemon collector
 * (kobe-daemon worktree-changes-collector via lib/poll-scheduling) — with
 * the production cadence constants, so the run counts below are the real
 * per-repo subprocess budget.
 */
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
  // The 30GB-repo freeze: a git-status per row per ~2s tick. The guards
  // bound that to "one run per adaptive window". These exact counts are
  // the budget — if a refactor loosens a guard, the counts jump.
  const TICKS = 100
  const TICK_MS = 2_000

  test("a slow-but-finishing repo (3s status) self-thins to exactly 12 runs", () => {
    // nextAllowed = finish + max(1.5s, 5×3s) → one run per 18s window:
    // t=0, 18s, 36s, … 198s = 12 of 100 ticks actually spawn git.
    expect(stormRuns({ ticks: TICKS, tickMs: TICK_MS, runDurationMs: 3_000, timedOut: false })).toBe(12)
  })

  test("a repo that always times out backs off to exactly 4 runs", () => {
    // Each run is killed at POLL_TIMEOUT_MS and backs off SLOW_REPO_RETRY_MS
    // from its START: t=0, 60s, 120s, 180s — 4 subprocesses in 200s, not 100.
    expect(stormRuns({ ticks: TICKS, tickMs: TICK_MS, runDurationMs: POLL_TIMEOUT_MS, timedOut: true })).toBe(4)
  })

  test("a fast repo (50ms status) keeps the tick cadence — every tick runs, never more", () => {
    // The MIN_POLL_INTERVAL_MS floor (1.5s) sits below the 2s tick, so a
    // fast repo polls at tick cadence: exactly one run per tick, and the
    // floor guarantees a finishing poll can never re-trigger within the
    // same tick (100 ticks → 100 runs, not 100+N).
    expect(stormRuns({ ticks: TICKS, tickMs: TICK_MS, runDurationMs: 50, timedOut: false })).toBe(TICKS)
  })
})
