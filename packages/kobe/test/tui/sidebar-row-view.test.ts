import { describe, expect, it } from "vitest"
import { buildSidebarRowView } from "../../src/tui/panes/sidebar/row-view.ts"
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
