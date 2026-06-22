import { describe, expect, it } from "vitest"
import {
  buildProjectOptions,
  buildRows,
  cursorIndexForProjectScope,
  reconcileSidebarRows,
  sameSidebarRowTask,
} from "../../src/tui/panes/sidebar/groups.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

function task(overrides: Omit<Partial<Task>, "id"> & { id: string; title: string }): Task {
  return {
    repo: "/repo/kobe",
    branch: overrides.title,
    worktreePath: `/repo/kobe/${overrides.id}`,
    kind: "task",
    status: "backlog",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    id: toTaskId(overrides.id),
  } as Task
}

function ids(rows: ReturnType<typeof buildRows>): string[] {
  return rows.map((row) => String(row.task.id))
}

describe("sidebar task ordering", () => {
  it("keeps default order as projects, pinned tasks, then persisted task order", () => {
    const rows = buildRows(
      [
        task({ id: "regular-a", title: "a" }),
        task({ id: "project", title: "repo", kind: "main", repo: "/repo/zeta" }),
        task({ id: "regular-b", title: "b" }),
        task({ id: "pinned", title: "pinned", pinned: true }),
      ],
      "active",
      "",
      "default",
    )

    expect(ids(rows)).toEqual(["project", "pinned", "regular-a", "regular-b"])
  })

  it("orders each section by recent use in recent mode", () => {
    const rows = buildRows(
      [
        task({ id: "old", title: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
        task({ id: "new", title: "new", updatedAt: "2026-01-03T00:00:00.000Z" }),
        task({ id: "pinned-old", title: "pinned old", pinned: true, updatedAt: "2026-01-02T00:00:00.000Z" }),
        task({ id: "pinned-new", title: "pinned new", pinned: true, updatedAt: "2026-01-04T00:00:00.000Z" }),
      ],
      "active",
      "",
      "recent",
    )

    expect(ids(rows)).toEqual(["pinned-new", "pinned-old", "new", "old"])
  })

  it("projects sit tight in recent mode — alphabetised, not reshuffled by use", () => {
    // alpha's repo basename is "alpha", zeta's is "zeta"; zeta was used more
    // recently, but projects stay alphabetised in recent mode (no reshuffle).
    const rows = buildRows(
      [
        task({
          id: "z",
          title: "zeta",
          kind: "main",
          repo: "/repo/zeta",
          updatedAt: "2026-06-10T00:00:00.000Z",
        }),
        task({
          id: "a",
          title: "alpha",
          kind: "main",
          repo: "/repo/alpha",
          updatedAt: "2020-01-01T00:00:00.000Z",
        }),
        task({ id: "reg", title: "reg" }),
      ],
      "active",
      "",
      "recent",
    )
    // alpha before zeta despite zeta being more recent.
    expect(ids(rows)).toEqual(["a", "z", "reg"])
  })

  it("shows one project row when stale duplicate main tasks share a repo", () => {
    const rows = buildRows(
      [
        task({ id: "project-a", title: "kobe", kind: "main", repo: "/repo/kobe" }),
        task({ id: "project-b", title: "kobe copy", kind: "main", repo: "/repo/kobe/" }),
        task({ id: "regular", title: "task" }),
      ],
      "active",
      "",
      "default",
    )

    expect(ids(rows)).toEqual(["project-a", "regular"])
  })

  it("does not collapse distinct projects just because their basenames match", () => {
    const rows = buildRows(
      [
        task({ id: "project-a", title: "kobe", kind: "main", repo: "/repo/a/kobe" }),
        task({ id: "project-b", title: "kobe", kind: "main", repo: "/repo/b/kobe" }),
      ],
      "active",
      "",
      "default",
    )

    expect(ids(rows)).toEqual(["project-a", "project-b"])
  })

  it("keeps project rows visible while filtering regular tasks to one project", () => {
    const rows = buildRows(
      [
        task({ id: "project-kobe", title: "kobe", kind: "main", repo: "/repo/kobe" }),
        task({ id: "project-pochi", title: "pochi", kind: "main", repo: "/repo/pochi" }),
        task({ id: "kobe-a", title: "kobe a", repo: "/repo/kobe" }),
        task({ id: "pochi-a", title: "pochi a", repo: "/repo/pochi" }),
      ],
      "active",
      "",
      "default",
      "/repo/kobe",
    )

    expect(ids(rows)).toEqual(["project-kobe", "project-pochi", "kobe-a"])
  })

  it("composes project filtering with recent task ordering", () => {
    const rows = buildRows(
      [
        task({ id: "kobe-old", title: "old", repo: "/repo/kobe", updatedAt: "2026-01-01T00:00:00.000Z" }),
        task({ id: "pochi-new", title: "other", repo: "/repo/pochi", updatedAt: "2026-01-05T00:00:00.000Z" }),
        task({ id: "kobe-new", title: "new", repo: "/repo/kobe", updatedAt: "2026-01-03T00:00:00.000Z" }),
      ],
      "active",
      "",
      "recent",
      "/repo/kobe",
    )

    expect(ids(rows)).toEqual(["kobe-new", "kobe-old"])
  })
})

describe("sidebar project filter options", () => {
  it("includes saved project rows even when the current view has no tasks for them", () => {
    const options = buildProjectOptions(
      [
        task({ id: "project-kobe", title: "kobe", kind: "main", repo: "/repo/kobe" }),
        task({ id: "project-pochi", title: "pochi", kind: "main", repo: "/repo/pochi" }),
        task({ id: "kobe-active", title: "active", repo: "/repo/kobe" }),
        task({ id: "pochi-archived", title: "archived", repo: "/repo/pochi", archived: true }),
      ],
      "active",
    )

    expect(options).toEqual([
      { repo: "/repo/kobe", label: "kobe", count: 1 },
      { repo: "/repo/pochi", label: "pochi", count: 0 },
    ])
  })

  it("counts tasks in the active view and disambiguates basename collisions", () => {
    const options = buildProjectOptions(
      [
        task({ id: "project-a", title: "kobe", kind: "main", repo: "/repo/a/kobe" }),
        task({ id: "project-b", title: "kobe", kind: "main", repo: "/repo/b/kobe" }),
        task({ id: "task-a", title: "a", repo: "/repo/a/kobe" }),
        task({ id: "task-b", title: "b", repo: "/repo/b/kobe" }),
      ],
      "active",
    )

    expect(options).toEqual([
      { repo: "/repo/a/kobe", label: "a/kobe", count: 1 },
      { repo: "/repo/b/kobe", label: "b/kobe", count: 1 },
    ])
  })
})

describe("sidebar project filter cursor", () => {
  it("lands on the first task in the project scope instead of the PROJECTS header rows", () => {
    const rows = buildRows(
      [
        task({ id: "project-kobe", title: "kobe", kind: "main", repo: "/repo/kobe" }),
        task({ id: "project-marketing", title: "marketing", kind: "main", repo: "/repo/marketingharness" }),
        task({ id: "marketing-a", title: "marketing a", repo: "/repo/marketingharness" }),
        task({ id: "kobe-a", title: "kobe a", repo: "/repo/kobe" }),
      ],
      "active",
      "",
      "default",
      "/repo/kobe",
    )

    expect(ids(rows)).toEqual(["project-kobe", "project-marketing", "kobe-a"])
    expect(cursorIndexForProjectScope(rows, "/repo/kobe")).toBe(2)
  })

  it("falls back to the project main row when the filtered project has no tasks in view", () => {
    const rows = buildRows(
      [
        task({ id: "project-kobe", title: "kobe", kind: "main", repo: "/repo/kobe" }),
        task({ id: "project-marketing", title: "marketing", kind: "main", repo: "/repo/marketingharness" }),
        task({ id: "marketing-a", title: "marketing a", repo: "/repo/marketingharness" }),
      ],
      "active",
      "",
      "default",
      "/repo/kobe",
    )

    expect(ids(rows)).toEqual(["project-kobe", "project-marketing"])
    expect(cursorIndexForProjectScope(rows, "/repo/kobe")).toBe(0)
  })

  it("keeps all-project scope at the top row", () => {
    const rows = buildRows(
      [
        task({ id: "project-kobe", title: "kobe", kind: "main", repo: "/repo/kobe" }),
        task({ id: "kobe-a", title: "kobe a", repo: "/repo/kobe" }),
      ],
      "active",
      "",
      "default",
      null,
    )

    expect(cursorIndexForProjectScope(rows, null)).toBe(0)
  })
})

/**
 * Identity contract for the sidebar's row reconciler (docs/DESIGN.md §5.5).
 *
 * Why these matter: the Tasks pane lives for days in every tmux session,
 * Solid's `<For>` keys rows by OBJECT IDENTITY, and @opentui/core 0.2.4
 * retains ~300B of native memory per renderable create/destroy cycle.
 * Every daemon `task.snapshot` push deserializes ALL-new Task objects —
 * including the no-visual-change push from `setActiveTask`'s recency
 * touch on EVERY task switch — so without reconciliation each push
 * destroyed and recreated every row's renderables (the same leak class
 * as the Ops-pane filetree, `test/tui/filetree-rows.test.ts`). The fix
 * is invisible to value-equality assertions: these tests pin identity
 * reuse with toBe — break it and the UI renders identically while the
 * leak silently returns.
 */
describe("reconcileSidebarRows", () => {
  it("a content-identical snapshot push returns the PREVIOUS array itself (no downstream notify)", () => {
    // Simulates the daemon echo: all-new Task objects, identical content.
    const prev = buildRows([task({ id: "a", title: "a" }), task({ id: "b", title: "b" })], "active", "", "default")
    const next = buildRows([task({ id: "a", title: "a" }), task({ id: "b", title: "b" })], "active", "", "default")
    expect(reconcileSidebarRows(prev, next)).toBe(prev)
  })

  it("an updatedAt-only bump (setActiveTask recency touch) does not re-key any row", () => {
    const prev = buildRows([task({ id: "a", title: "a" }), task({ id: "b", title: "b" })], "active", "", "default")
    const next = buildRows(
      [task({ id: "a", title: "a", updatedAt: "2026-06-10T12:00:00.000Z" }), task({ id: "b", title: "b" })],
      "active",
      "",
      "default",
    )
    expect(reconcileSidebarRows(prev, next)).toBe(prev)
  })

  it("a changed task gets a fresh row; unchanged siblings keep their previous object identity", () => {
    const prev = buildRows([task({ id: "a", title: "a" }), task({ id: "b", title: "b" })], "active", "", "default")
    const next = buildRows(
      [task({ id: "a", title: "renamed" }), task({ id: "b", title: "b" })],
      "active",
      "",
      "default",
    )
    const out = reconcileSidebarRows(prev, next)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(next[0]) // title changed → fresh object (renderer captures task non-reactively)
    expect(out[1]).toBe(prev[1]) // untouched → reused, <For> keeps its renderables
  })

  it("a reorder breaks reuse via flatIndex (renderer captures flatIndex non-reactively)", () => {
    const prev = buildRows([task({ id: "a", title: "a" }), task({ id: "b", title: "b" })], "active", "", "default")
    const next = buildRows([task({ id: "b", title: "b" }), task({ id: "a", title: "a" })], "active", "", "default")
    const out = reconcileSidebarRows(prev, next)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(next[0])
    expect(out[1]).toBe(next[1])
  })

  it("appending a task reuses every existing row", () => {
    const prev = buildRows([task({ id: "a", title: "a" })], "active", "", "default")
    const next = buildRows([task({ id: "a", title: "a" }), task({ id: "b", title: "b" })], "active", "", "default")
    const out = reconcileSidebarRows(prev, next)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0])
    expect(out[1]).toBe(next[1])
  })

  it("empty prev passes next through untouched", () => {
    const next = buildRows([task({ id: "a", title: "a" })], "active", "", "default")
    expect(reconcileSidebarRows([], next)).toBe(next)
  })
})

describe("sameSidebarRowTask", () => {
  it("ignores updatedAt/createdAt but notices every rendered field", () => {
    const base = task({ id: "a", title: "a" })
    expect(sameSidebarRowTask(base, task({ id: "a", title: "a", updatedAt: "2027-01-01T00:00:00.000Z" }))).toBe(true)
    expect(sameSidebarRowTask(base, task({ id: "a", title: "a", status: "in_progress" }))).toBe(false)
    expect(sameSidebarRowTask(base, task({ id: "a", title: "a", branch: "feat/x" }))).toBe(false)
    expect(sameSidebarRowTask(base, task({ id: "a", title: "a", pinned: true }))).toBe(false)
    expect(sameSidebarRowTask(base, task({ id: "a", title: "a", archived: true }))).toBe(false)
    expect(sameSidebarRowTask(base, task({ id: "a", title: "a", vendor: "codex" }))).toBe(false)
  })
})
