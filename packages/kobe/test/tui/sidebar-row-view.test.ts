/**
 * What's left here after the golden took over.
 *
 * `test/golden/sidebar-row-state.golden.txt` now enumerates
 * `buildSidebarRowView` over its whole input space — every activity state ×
 * seen bit × job × deletion phase × vendor × transcript, plus the spinner sets,
 * the completion grace window, subagent marks and subtitle truncation. Every
 * per-state assertion that used to live in this file was one sampled row of
 * that table, so those cases were removed rather than kept as a second, less
 * complete copy that could disagree with it.
 *
 * What stayed is what a table of outputs cannot say:
 *
 *  - a COLLAPSE across an axis the golden deliberately excludes (persisted
 *    lifecycle status must have no effect on runtime chrome at all — the
 *    assertion is "all six statuses produce ONE projection", which is a
 *    property, not a row);
 *  - agreement BETWEEN two functions (`rowIsLoading` / `anyRowLoading` vs the
 *    view's own `loading`), which no single snapshot can express;
 *  - `sweepBar`, which belongs to a different module entirely.
 */

import { describe, expect, it } from "vitest"
import { sweepBar } from "../../src/tui/lib/progress-bar.ts"
import { anyRowLoading, buildSidebarRowView, rowIsLoading } from "../../src/tui/panes/sidebar/row-view.ts"
import type { Task, TaskStatus } from "../../src/types/task.ts"
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

/**
 * The row is a RUNTIME projection. `TaskStatus` is the user-driven board
 * lifecycle, and letting it leak in here is how a `done` task once rendered as
 * finished while its engine was mid-turn. Stated as a collapse — all six
 * statuses must yield ONE projection — so a new status added to the union is
 * covered the day it lands, without anyone remembering to extend a table.
 */
describe("persisted lifecycle status never reaches the runtime row", () => {
  const lifecycleStatuses: readonly TaskStatus[] = ["backlog", "in_progress", "in_review", "done", "canceled", "error"]

  const projectionsFor = (extra: Parameters<typeof task>[0] = {}) =>
    lifecycleStatuses.map((status) => {
      const row = view({ ...extra, status })
      return { loading: row.loading, stateGlyph: row.stateGlyph, tone: row.tone, subtitleText: row.subtitleText }
    })

  it("does not project task lifecycle status into a branched task's runtime chrome", () => {
    const projections = projectionsFor()
    expect(new Set(projections.map((projection) => JSON.stringify(projection))).size).toBe(1)
    expect(projections[0]).toEqual({
      loading: false,
      stateGlyph: "○",
      tone: "textMuted",
      subtitleText: "feature/sidebar",
    })
  })

  it("uses the same neutral fallback for every lifecycle status when a task has no branch", () => {
    const projections = projectionsFor({ branch: "" })
    expect(new Set(projections.map((projection) => JSON.stringify(projection))).size).toBe(1)
    expect(projections[0]).toEqual({ loading: false, stateGlyph: "○", tone: "textMuted", subtitleText: "—" })
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

// O11: the pane-level spinner gate must be exactly the OR of the per-row
// loading decisions the cards render, or a genuinely-loading row freezes.
// This is an agreement between three functions, which is why it survived the
// move to the golden — the table records outputs, not that they match.
describe("rowIsLoading / anyRowLoading (spinner gate)", () => {
  const base = { spinnerFrame: 0, subtitleBudget: 80, truncateBranch: (b: string) => b } as const

  it("rowIsLoading matches buildSidebarRowView.loading across cases", () => {
    const cases = [
      { task: task({ status: "in_progress" }) },
      { task: task({ status: "backlog" }) },
      { task: task({ kind: "main", branch: "", status: "in_progress" }) },
      { task: task({ status: "done" }), job: { kind: "ensureWorktree" as const } },
      { task: task({}), activity: { state: "running" as const, at: 1 } },
      // A custom engine has no transcript store to watch, so its rest state is
      // "untracked" rather than idle — the one input where the two functions
      // could plausibly have been written to disagree.
      { task: task({ vendor: "my-custom-engine" }) },
      { task: task({ deletion: { phase: "running" as const, force: true, requestedAt: "2026-07-15T00:00:00.000Z" } }) },
    ]
    for (const c of cases) {
      const built = buildSidebarRowView({ ...base, ...c })
      expect(rowIsLoading(c)).toBe(built.loading)
    }
  })

  it("anyRowLoading is true iff at least one row has live runtime activity", () => {
    const idle = task({ id: "idle", status: "backlog" })
    const busy = task({ id: "busy", status: "in_progress" })
    const reads = {
      activity: (id: string) => (id === "busy" ? ({ state: "running" as const, at: 1 } as const) : undefined),
      job: () => undefined,
    }
    expect(anyRowLoading([idle], reads)).toBe(false)
    expect(anyRowLoading([idle, busy], reads)).toBe(true)
    expect(anyRowLoading([], reads)).toBe(false)
  })
})
