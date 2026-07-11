import { describe, expect, it } from "vitest"
import { CLAUDE_SPINNER_FRAMES, REDUCED_MOTION_SPINNER_FRAMES } from "../../src/engine/spinner-frames.ts"
import { sweepBar } from "../../src/tui/lib/progress-bar.ts"
import {
  anyRowLoading,
  buildSidebarRowView,
  rowIsLoading,
  withSpinnerFrame,
} from "../../src/tui/panes/sidebar/row-view.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

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

function view(overrides: Parameters<typeof task>[0], activity?: Parameters<typeof buildSidebarRowView>[0]["activity"]) {
  return buildSidebarRowView({
    task: task(overrides),
    activity,
    spinnerFrame: 0,
    subtitleBudget: 80,
    truncateBranch: (branch) => branch,
  })
}

describe("buildSidebarRowView", () => {
  it("keeps turn-complete as the visible row badge", () => {
    expect(view({ status: "in_progress" }, { state: "turn_complete", at: 1 })).toMatchObject({
      loading: false,
      stateGlyph: "✓",
      tone: "primary",
    })
  })

  it("does not use stale in-progress status for main project rows", () => {
    expect(view({ kind: "main", branch: "", status: "in_progress" })).toMatchObject({
      loading: false,
      projectGlyph: "★",
      titleText: "kobe",
    })
  })

  it("uses activity states before persisted lifecycle status", () => {
    expect(view({ status: "done" }, { state: "permission_needed", at: 1 })).toMatchObject({
      loading: false,
      stateGlyph: "?",
      tone: "warning",
    })
  })

  it("spins (loading) while the engine reports a running turn", () => {
    expect(view({ status: "backlog" }, { state: "running", at: 1 })).toMatchObject({
      loading: true,
      tone: "primary",
    })
  })

  it("spells out rate-limited in the subtitle with the clock badge", () => {
    expect(view({ status: "backlog" }, { state: "rate_limited", at: 1 })).toMatchObject({
      loading: false,
      stateGlyph: "◷",
      tone: "warning",
      subtitleText: "rate limited",
    })
  })

  it("spells out an engine error in the subtitle with the error badge", () => {
    expect(view({ status: "backlog" }, { state: "error", at: 1 })).toMatchObject({
      loading: false,
      stateGlyph: "✕",
      tone: "error",
      subtitleText: "error",
    })
  })

  it("shows the repo-root branch (mainBranch) as a project row's subtitle", () => {
    const v = buildSidebarRowView({
      task: task({ kind: "main", branch: "", status: "backlog" }),
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
      mainBranch: "main",
    })
    expect(v).toMatchObject({ isMain: true, titleText: "kobe", subtitleText: "main" })
  })

  // Long daemon job feedback (issue #5): while the daemon's blocking
  // `task.ensureWorktree` RPC runs a minutes-long `git worktree add`, the
  // `task.jobs` channel marks the task in every attached pane; the row must
  // spin with a "materializing" subtitle instead of sitting frozen on the
  // backlog dot (or lying with a branch label that doesn't exist on disk yet).
  it("spins with a materializing subtitle while a worktree job is in flight", () => {
    const v = buildSidebarRowView({
      task: task({ status: "backlog", branch: "", worktreePath: "" }),
      job: { kind: "ensureWorktree" },
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
    expect(v).toMatchObject({
      // Claude-vendor task → the engine-owned star frames (frame 0 = "·").
      loading: true,
      stateGlyph: CLAUDE_SPINNER_FRAMES[0],
      tone: "primary",
      subtitleText: "materializing",
      materializing: true,
    })
  })

  it("the materializing word outranks the branch label while the job runs", () => {
    const v = buildSidebarRowView({
      task: task({ status: "backlog", branch: "feature/sidebar" }),
      job: { kind: "ensureWorktree" },
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
    expect(v.subtitleText).toBe("materializing")
    expect(v.loading).toBe(true)
  })

  it("spins for a custom-engine task too while its worktree job runs (job is daemon truth, not engine telemetry)", () => {
    const v = buildSidebarRowView({
      task: task({ status: "backlog", vendor: "my-custom-engine", branch: "" }),
      job: { kind: "ensureWorktree" },
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
    expect(v).toMatchObject({ loading: true, tone: "primary", subtitleText: "materializing" })
  })

  it("falls back to a neutral dash for a project with no resolvable branch", () => {
    const v = buildSidebarRowView({
      task: task({ kind: "main", branch: "", status: "backlog" }),
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
      mainBranch: "",
    })
    expect(v.subtitleText).toBe("—")
  })
})

// The spinner-frame overlay is what makes the 10Hz tick a CONDITIONAL
// dependency in the Sidebar (waste audit): the frame accessor must only
// be read for loading rows, so an idle sidebar does zero per-tick work
// — Solid's dep collection drops the tick signal entirely when nothing
// is spinning. These tests pin both halves: identity preservation +
// accessor non-read for idle rows, exact frame overlay for loading ones.
describe("withSpinnerFrame", () => {
  function loadingView() {
    return buildSidebarRowView({
      task: task({ status: "backlog" }),
      activity: { state: "running", at: 1 },
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
  }

  it("returns an idle view UNCHANGED and never reads the frame accessor", () => {
    const idle = view({ status: "done" })
    expect(idle.loading).toBe(false)
    let reads = 0
    const out = withSpinnerFrame(idle, () => {
      reads++
      return 3
    })
    expect(out).toBe(idle) // identity preserved → downstream memos never notify
    expect(reads).toBe(0) // the 10Hz signal is not a dependency of idle rows
  })

  it("overlays the live frame on both glyph fields of a loading view", () => {
    const base = loadingView()
    expect(base.loading).toBe(true)
    const out = withSpinnerFrame(base, () => 3)
    // The overlay honours the view's OWN engine frame set (claude stars here).
    expect(out.stateGlyph).toBe(base.spinnerFrames[3])
    expect(out.projectGlyph).toBe(base.spinnerFrames[3])
    // Everything else is untouched — exactly what buildSidebarRowView
    // would have produced with spinnerFrame: 3.
    const direct = buildSidebarRowView({
      task: task({ status: "backlog" }),
      activity: { state: "running", at: 1 },
      spinnerFrame: 3,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
    expect(out).toEqual(direct)
  })

  it("keeps identity when the frame resolves to the glyph already shown", () => {
    const base = loadingView() // built with frame 0
    const out = withSpinnerFrame(base, () => 0)
    expect(out).toBe(base)
  })

  it("wraps out-of-range frames into the spinner cycle", () => {
    const base = loadingView()
    const out = withSpinnerFrame(base, () => base.spinnerFrames.length + 2)
    expect(out.stateGlyph).toBe(base.spinnerFrames[2])
  })

  it("reduced motion swaps every engine's frames for the pulsing dot", () => {
    const v = buildSidebarRowView({
      task: task({ status: "backlog" }),
      activity: { state: "running", at: 1 },
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
      reducedMotion: true,
    })
    expect(v.spinnerFrames).toBe(REDUCED_MOTION_SPINNER_FRAMES)
    expect(v.stateGlyph).toBe("●")
    // Second phase of the 2s cycle (frames 10-19) is the small dot.
    expect(withSpinnerFrame(v, () => 15).stateGlyph).toBe("·")
  })
})

// Chrome-animation helper — pure string math, pinned so a refactor can't
// silently break the sweep geometry.
describe("sweepBar", () => {
  it("sweepBar always renders exactly `width` cells and the comet crosses the track", () => {
    for (let frame = 0; frame < 30; frame++) {
      expect(sweepBar(frame, 8)).toHaveLength(8)
    }
    expect(sweepBar(0, 8)).toBe("█       ")
    expect(sweepBar(2, 8)).toBe("▍▋█     ")
    // Head has run off the end: comet fully exited before the wrap.
    expect(sweepBar(10, 8)).toBe("        ")
  })
})

describe("buildSidebarRowView — defer to the live terminal (isViewed)", () => {
  const base = { spinnerFrame: 0, subtitleBudget: 80, truncateBranch: (b: string) => b } as const

  it("spins for an in-progress task whose terminal is NOT the one on screen", () => {
    const v = buildSidebarRowView({ task: task({ status: "in_progress" }), ...base, isViewed: false })
    expect(v.loading).toBe(true)
  })

  it("suppresses its own spinner when the task's terminal is the one being viewed", () => {
    // claude/codex draws its OWN zero-latency spinner in the visible pane, so
    // kobe's derived (laggier) spinner would be a duplicate — the viewed row
    // defers to the live terminal instead of animating.
    const v = buildSidebarRowView({ task: task({ status: "in_progress" }), ...base, isViewed: true })
    expect(v.loading).toBe(false)
    expect(v.stateGlyph).toBe("")
  })

  it("still spins a viewed row while its worktree materializes (no terminal yet)", () => {
    const v = buildSidebarRowView({
      task: task({ status: "in_progress" }),
      ...base,
      isViewed: true,
      job: { kind: "ensureWorktree" },
    })
    expect(v.loading).toBe(true)
  })
})

// O11: the pane-level spinner gate must be exactly the OR of the per-row
// loading decisions the cards render, or a genuinely-loading row freezes.
describe("rowIsLoading / anyRowLoading (spinner gate)", () => {
  const base = { spinnerFrame: 0, subtitleBudget: 80, truncateBranch: (b: string) => b } as const

  it("rowIsLoading matches buildSidebarRowView.loading across cases", () => {
    const cases = [
      { task: task({ status: "in_progress" }) },
      { task: task({ status: "in_progress" }), isViewed: true },
      { task: task({ status: "backlog" }) },
      { task: task({ kind: "main", branch: "", status: "in_progress" }) },
      { task: task({ status: "done" }), job: { kind: "ensureWorktree" as const } },
      { task: task({}), activity: { state: "running" as const, at: 1 } },
    ]
    for (const c of cases) {
      const view = buildSidebarRowView({ ...base, ...c })
      expect(rowIsLoading(c)).toBe(view.loading)
    }
  })

  it("anyRowLoading is true iff at least one row spins", () => {
    const idle = task({ id: "idle", status: "backlog" })
    const busy = task({ id: "busy", status: "in_progress" })
    const reads = {
      activity: () => undefined,
      job: () => undefined,
      isViewed: () => false,
    }
    expect(anyRowLoading([idle], reads)).toBe(false)
    expect(anyRowLoading([idle, busy], reads)).toBe(true)
    expect(anyRowLoading([], reads)).toBe(false)
  })

  it("a viewed busy row does not by itself keep the pane spinning", () => {
    const busy = task({ id: "busy", status: "in_progress" })
    const reads = {
      activity: () => undefined,
      job: () => undefined,
      isViewed: (id: string) => id === "busy",
    }
    // The only busy row is the one on screen (its terminal draws its own
    // spinner), so the pane has nothing to animate.
    expect(anyRowLoading([busy], reads)).toBe(false)
  })
})
