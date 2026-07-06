import { describe, expect, it } from "vitest"
import { IN_PROGRESS_SPINNER, buildSidebarRowView, withSpinnerFrame } from "../../src/tui/panes/sidebar/row-view.ts"
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
    live: false,
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
      live: false,
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
      mainBranch: "main",
    })
    expect(v).toMatchObject({ isMain: true, titleText: "kobe", subtitleText: "main" })
  })

  it("spins with a materializing subtitle while a worktree job is in flight", () => {
    const v = buildSidebarRowView({
      task: task({ status: "backlog", branch: "", worktreePath: "" }),
      job: { kind: "ensureWorktree" },
      live: false,
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
    expect(v).toMatchObject({
      loading: true,
      stateGlyph: "⠋",
      tone: "primary",
      subtitleText: "materializing",
    })
  })

  it("the materializing word outranks the branch label while the job runs", () => {
    const v = buildSidebarRowView({
      task: task({ status: "backlog", branch: "feature/sidebar" }),
      job: { kind: "ensureWorktree" },
      live: false,
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
      live: false,
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
    expect(v).toMatchObject({ loading: true, tone: "primary", subtitleText: "materializing" })
  })

  it("falls back to a neutral dash for a project with no resolvable branch", () => {
    const v = buildSidebarRowView({
      task: task({ kind: "main", branch: "", status: "backlog" }),
      live: false,
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
      mainBranch: "",
    })
    expect(v.subtitleText).toBe("—")
  })
})

describe("withSpinnerFrame", () => {
  function loadingView() {
    return buildSidebarRowView({
      task: task({ status: "backlog" }),
      activity: { state: "running", at: 1 },
      live: false,
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
    expect(out).toBe(idle)
    expect(reads).toBe(0)
  })

  it("overlays the live frame on both glyph fields of a loading view", () => {
    const base = loadingView()
    expect(base.loading).toBe(true)
    const out = withSpinnerFrame(base, () => 3)
    expect(out.stateGlyph).toBe(IN_PROGRESS_SPINNER[3])
    expect(out.projectGlyph).toBe(IN_PROGRESS_SPINNER[3])
    const direct = buildSidebarRowView({
      task: task({ status: "backlog" }),
      activity: { state: "running", at: 1 },
      live: false,
      spinnerFrame: 3,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
    expect(out).toEqual(direct)
  })

  it("keeps identity when the frame resolves to the glyph already shown", () => {
    const base = loadingView()
    const out = withSpinnerFrame(base, () => 0)
    expect(out).toBe(base)
  })

  it("wraps out-of-range frames into the spinner cycle", () => {
    const base = loadingView()
    const out = withSpinnerFrame(base, () => IN_PROGRESS_SPINNER.length + 2)
    expect(out.stateGlyph).toBe(IN_PROGRESS_SPINNER[2])
  })
})
