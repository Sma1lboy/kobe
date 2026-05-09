/**
 * Stream F + W4.A — Sidebar pane component tests.
 *
 * These exercise the sidebar's pure layout + navigation logic. The full
 * Solid component (`Sidebar`) is rendered through `@opentui/core`'s
 * native bindings under Bun at runtime; vitest's worker pool runs in
 * Node and cannot load opentui's bun-ffi-structs, so a `testRender`
 * roundtrip is not possible without restructuring the project's test
 * runner. We mitigate that by:
 *
 *   1. Splitting all rendering-independent logic into pure functions
 *      (`buildRows`, `flattenIds`, `groupByRepo`,
 *      `createSidebarController`) and asserting on those directly.
 *   2. Letting the behavior tests (PTY-driven, real binary) prove the
 *      visible end-to-end rendering — `sidebar-delete.test.ts` and
 *      `sidebar-status-update.test.ts` exercise the sidebar against the
 *      real `bun run dev` process.
 *
 * Wave 4 W4.A: status-grouping is gone — we group by `Task.repo`. The
 * `TaskStatus` field stays on disk and drives concurrency cap; the
 * sidebar still renders a per-row status badge as a visual hint, but
 * does not group, sort, or re-order by status. These tests assert the
 * new repo-grouped contract.
 */

import { GG_CHORD_TIMEOUT_MS, createSidebarController } from "@/tui/panes/sidebar/controller"
// We import directly from the leaf modules (not the barrel
// `@/tui/panes/sidebar`) because the barrel re-exports the JSX
// component, which transitively drags in `@opentui/core`. opentui's
// native bindings require Bun's runtime; vitest uses Node's, which
// would crash module init with `Unknown file extension ".scm"`. The
// pure logic lives in `./groups` and `./controller` and has no opentui
// imports — that's what we exercise here.
import { buildRows, flattenIds, groupByRepo, repoLabel } from "@/tui/panes/sidebar/groups"
import type { Task, TaskStatus } from "@/types"
import { toTaskId } from "@/types"
import { describe, expect, test, vi } from "vitest"

/**
 * Build a minimal {@link Task} for tests. ULIDs are not required — the
 * sidebar uses ids only for equality and selection, not for sorting.
 *
 * `repo` defaults to `/tmp/repo` so existing call sites stay terse;
 * tests that exercise multi-repo grouping override it explicitly.
 */
function makeTask(id: string, title: string, status: TaskStatus, repo = "/tmp/repo"): Task {
  const now = "2026-05-08T00:00:00.000Z"
  return {
    id: toTaskId(id),
    title,
    repo,
    branch: `kobe/${id}`,
    worktreePath: `${repo}/.kobe/worktrees/${id}`,
    sessionId: null,
    status,
    createdAt: now,
    updatedAt: now,
  }
}

// 5 mock tasks across 2 repos, varied statuses — exercises the new
// repo-grouped layout and proves status no longer drives ordering.
const TWO_REPO_TASKS: Task[] = [
  makeTask("01", "fix login redirect", "in_progress", "/Users/jacksonc/i/my-frontend"),
  makeTask("02", "refactor auth", "backlog", "/Users/jacksonc/i/my-frontend"),
  makeTask("03", "add password reset", "backlog", "/Users/jacksonc/i/my-frontend"),
  makeTask("04", "migrate to fastify", "in_progress", "/Users/jacksonc/i/api-server"),
  makeTask("05", "fix CORS regression", "done", "/Users/jacksonc/i/api-server"),
]

// ---------------------------------------------------------------------
// groupByRepo — pure grouping
// ---------------------------------------------------------------------

describe("groupByRepo", () => {
  test("returns an empty Map for an empty task list", () => {
    const out = groupByRepo([])
    expect(out.size).toBe(0)
  })

  test("groups tasks by their repo path", () => {
    const out = groupByRepo(TWO_REPO_TASKS)
    expect(out.size).toBe(2)
    const fe = out.get("/Users/jacksonc/i/my-frontend")
    const api = out.get("/Users/jacksonc/i/api-server")
    expect(fe?.map((t) => t.id)).toEqual(["01", "02", "03"])
    expect(api?.map((t) => t.id)).toEqual(["04", "05"])
  })

  test("preserves first-seen repo order across mixed input", () => {
    // Interleaved: api, fe, api, fe — the api repo appears first so the
    // iteration order should be api then fe regardless of how many
    // tasks each holds.
    const tasks: Task[] = [
      makeTask("a", "A", "in_progress", "/repos/api"),
      makeTask("b", "B", "backlog", "/repos/fe"),
      makeTask("c", "C", "done", "/repos/api"),
      makeTask("d", "D", "backlog", "/repos/fe"),
    ]
    const out = groupByRepo(tasks)
    expect([...out.keys()]).toEqual(["/repos/api", "/repos/fe"])
    expect(out.get("/repos/api")?.map((t) => t.id)).toEqual(["a", "c"])
    expect(out.get("/repos/fe")?.map((t) => t.id)).toEqual(["b", "d"])
  })

  test("preserves input order within a repo regardless of status", () => {
    // Tasks of the same repo with mixed statuses must stay in input
    // order — the sidebar no longer reorders by status.
    const tasks: Task[] = [
      makeTask("a", "A", "done", "/repos/x"),
      makeTask("b", "B", "in_progress", "/repos/x"),
      makeTask("c", "C", "backlog", "/repos/x"),
      makeTask("d", "D", "in_review", "/repos/x"),
    ]
    const out = groupByRepo(tasks)
    expect(out.get("/repos/x")?.map((t) => t.id)).toEqual(["a", "b", "c", "d"])
  })

  test("does not mutate the input array", () => {
    const tasks: Task[] = [makeTask("a", "A", "done"), makeTask("b", "B", "backlog")]
    const snapshot = JSON.stringify(tasks)
    groupByRepo(tasks)
    expect(JSON.stringify(tasks)).toBe(snapshot)
  })
})

// ---------------------------------------------------------------------
// repoLabel — display name for the repo header
// ---------------------------------------------------------------------

describe("repoLabel", () => {
  test("returns the basename of an absolute repo path", () => {
    expect(repoLabel("/Users/jacksonc/i/my-frontend")).toBe("my-frontend")
    expect(repoLabel("/tmp/repo")).toBe("repo")
  })

  test("falls back to the full path when basename is empty (defensive)", () => {
    // path.basename("/") returns "" — the fallback keeps the row
    // visible even on an unusual repo value.
    expect(repoLabel("/")).toBe("/")
  })
})

// ---------------------------------------------------------------------
// buildRows — visible row layout
// ---------------------------------------------------------------------

describe("buildRows", () => {
  test("returns an empty list for empty input (no synthetic header)", () => {
    const rows = buildRows([])
    expect(rows).toEqual([])
  })

  test("emits a repo-header followed by N task rows for each repo", () => {
    const rows = buildRows(TWO_REPO_TASKS)
    // Expected layout: [my-frontend header, t01, t02, t03,
    //                   api-server header, t04, t05]
    expect(rows).toHaveLength(7)
    expect(rows[0]).toMatchObject({ kind: "repo-header", label: "my-frontend", count: 3 })
    expect(rows[1]).toMatchObject({ kind: "task", task: { id: "01" }, flatIndex: 0 })
    expect(rows[2]).toMatchObject({ kind: "task", task: { id: "02" }, flatIndex: 1 })
    expect(rows[3]).toMatchObject({ kind: "task", task: { id: "03" }, flatIndex: 2 })
    expect(rows[4]).toMatchObject({ kind: "repo-header", label: "api-server", count: 2 })
    expect(rows[5]).toMatchObject({ kind: "task", task: { id: "04" }, flatIndex: 3 })
    expect(rows[6]).toMatchObject({ kind: "task", task: { id: "05" }, flatIndex: 4 })
  })

  test("repo header carries the absolute repo path as the grouping key", () => {
    const rows = buildRows(TWO_REPO_TASKS)
    const header = rows.find((r) => r.kind === "repo-header")
    if (!header || header.kind !== "repo-header") throw new Error("expected a repo-header row")
    expect(header.repo).toBe("/Users/jacksonc/i/my-frontend")
    expect(header.label).toBe("my-frontend")
  })

  test("flatIndex on task rows is monotonically increasing across repos", () => {
    const rows = buildRows(TWO_REPO_TASKS)
    const taskRows = rows.filter((r) => r.kind === "task")
    expect(taskRows).toHaveLength(5)
    for (let i = 0; i < taskRows.length; i++) {
      const r = taskRows[i]
      if (r && r.kind === "task") expect(r.flatIndex).toBe(i)
    }
  })

  test("renders a single repo header even when only one repo has tasks", () => {
    // Single-repo collapse decision: we DO NOT collapse the header
    // when there's exactly one repo. The header always renders so the
    // layout stays stable as the user adds repos and so the multi-repo
    // nature of kobe is visible from keystroke one. (See HANDOFF.md
    // open question #3 — the answer recorded in W4.A's commit message.)
    const tasks: Task[] = [
      makeTask("a", "A", "in_progress", "/repos/only"),
      makeTask("b", "B", "backlog", "/repos/only"),
    ]
    const rows = buildRows(tasks)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ kind: "repo-header", label: "only", count: 2 })
    expect(rows[1]).toMatchObject({ kind: "task", task: { id: "a" } })
    expect(rows[2]).toMatchObject({ kind: "task", task: { id: "b" } })
  })
})

describe("flattenIds", () => {
  test("returns task ids in render order, skipping repo headers", () => {
    const rows = buildRows(TWO_REPO_TASKS)
    const ids = flattenIds(rows)
    // Order matches buildRows: my-frontend (01,02,03), api-server (04,05).
    expect(ids).toEqual(["01", "02", "03", "04", "05"])
  })

  test("returns an empty array for an empty rows list", () => {
    expect(flattenIds([])).toEqual([])
  })
})

// ---------------------------------------------------------------------
// createSidebarController — j/k/enter/g/G navigation logic
// ---------------------------------------------------------------------

/**
 * Helper: build a controller whose state is exposed for assertion. We
 * inject a manual scheduler for chord timing so tests can advance the
 * clock deterministically.
 */
function makeHarness(initialIds: readonly string[]) {
  const ids = [...initialIds]
  let cursor = 0
  const selected: string[] = []
  const pendingTimers: { fire: () => void }[] = []
  const ctrl = createSidebarController({
    getCursor: () => cursor,
    setCursor: (n) => {
      cursor = n
    },
    getFlatIds: () => ids,
    onSelect: (id) => selected.push(id),
    scheduleTimeout: (cb) => {
      const t = { fire: cb }
      pendingTimers.push(t)
      return () => {
        const idx = pendingTimers.indexOf(t)
        if (idx >= 0) pendingTimers.splice(idx, 1)
      }
    },
  })
  return {
    ctrl,
    state: () => ({ cursor, selected: [...selected], pendingTimers: pendingTimers.length }),
    setIds: (next: readonly string[]) => {
      ids.splice(0, ids.length, ...next)
    },
    expireChord: () => {
      const timers = [...pendingTimers]
      pendingTimers.splice(0, pendingTimers.length)
      for (const t of timers) t.fire()
    },
  }
}

describe("createSidebarController", () => {
  test("moveDown / moveUp clamp to [0, ids.length-1]", () => {
    const h = makeHarness(["a", "b", "c"])
    expect(h.state().cursor).toBe(0)
    h.ctrl.moveDown()
    expect(h.state().cursor).toBe(1)
    h.ctrl.moveDown()
    expect(h.state().cursor).toBe(2)
    h.ctrl.moveDown() // clamp at end
    expect(h.state().cursor).toBe(2)
    h.ctrl.moveUp()
    expect(h.state().cursor).toBe(1)
    h.ctrl.moveUp()
    h.ctrl.moveUp() // clamp at start
    expect(h.state().cursor).toBe(0)
  })

  test("selectCurrent invokes onSelect with the id under the cursor", () => {
    const h = makeHarness(["a", "b", "c"])
    h.ctrl.moveDown()
    h.ctrl.selectCurrent()
    expect(h.state().selected).toEqual(["b"])
  })

  test("selectCurrent is a no-op when the list is empty", () => {
    const h = makeHarness([])
    h.ctrl.selectCurrent()
    expect(h.state().selected).toEqual([])
  })

  test("pressShiftG jumps to the last id", () => {
    const h = makeHarness(["a", "b", "c", "d"])
    h.ctrl.pressShiftG()
    expect(h.state().cursor).toBe(3)
    h.ctrl.selectCurrent()
    expect(h.state().selected).toEqual(["d"])
  })

  test("pressG once arms the chord; second press jumps to top", () => {
    const h = makeHarness(["a", "b", "c"])
    h.ctrl.moveDown()
    h.ctrl.moveDown()
    expect(h.state().cursor).toBe(2)
    h.ctrl.pressG()
    expect(h.ctrl.isChordArmed()).toBe(true)
    expect(h.state().cursor).toBe(2) // first g doesn't move
    h.ctrl.pressG()
    expect(h.ctrl.isChordArmed()).toBe(false)
    expect(h.state().cursor).toBe(0)
  })

  test("chord disarms after the timeout expires", () => {
    const h = makeHarness(["a", "b", "c"])
    h.ctrl.pressG()
    expect(h.ctrl.isChordArmed()).toBe(true)
    h.expireChord()
    expect(h.ctrl.isChordArmed()).toBe(false)
    // A subsequent g should re-arm, not jump.
    h.ctrl.pressG()
    expect(h.ctrl.isChordArmed()).toBe(true)
    expect(h.state().cursor).toBe(0)
  })

  test("any non-g navigation disarms a pending chord", () => {
    const h = makeHarness(["a", "b", "c"])
    h.ctrl.pressG()
    expect(h.ctrl.isChordArmed()).toBe(true)
    h.ctrl.moveDown()
    expect(h.ctrl.isChordArmed()).toBe(false)
  })

  test("Shift+G disarms a pending chord", () => {
    const h = makeHarness(["a", "b", "c"])
    h.ctrl.pressG()
    expect(h.ctrl.isChordArmed()).toBe(true)
    h.ctrl.pressShiftG()
    expect(h.ctrl.isChordArmed()).toBe(false)
    expect(h.state().cursor).toBe(2)
  })

  test("GG_CHORD_TIMEOUT_MS is a positive number bounded reasonably", () => {
    expect(typeof GG_CHORD_TIMEOUT_MS).toBe("number")
    expect(GG_CHORD_TIMEOUT_MS).toBeGreaterThan(0)
    expect(GG_CHORD_TIMEOUT_MS).toBeLessThan(5_000)
  })
})

// ---------------------------------------------------------------------
// Cursor + grouping integration: the brief asks j/k navigation skip
// repo headers. The component does that by indexing into a flat-ids
// array (which excludes headers). We exercise that wiring against the
// actual buildRows / flattenIds output.
// ---------------------------------------------------------------------

describe("cursor navigation over repo-grouped tasks", () => {
  test("j/k navigation only stops on task rows, never on repo headers", () => {
    const rows = buildRows(TWO_REPO_TASKS)
    const ids = flattenIds(rows)
    const h = makeHarness(ids)

    // Start on first task ("01"). Walk down; cursor walks task ids
    // only; the controller never gives us a header position.
    expect(h.state().cursor).toBe(0)
    expect(ids[h.state().cursor]).toBe("01")
    h.ctrl.moveDown()
    expect(ids[h.state().cursor]).toBe("02")
    h.ctrl.moveDown()
    expect(ids[h.state().cursor]).toBe("03")
    h.ctrl.moveDown()
    // At this point the rendered list crosses the my-frontend → api-server
    // boundary (repo header in between), but the cursor lands on "04" —
    // no intermediate header stop.
    expect(ids[h.state().cursor]).toBe("04")
    h.ctrl.moveDown()
    expect(ids[h.state().cursor]).toBe("05")
  })

  test("enter on the cursor row calls onSelect with the right id", () => {
    const ids = flattenIds(buildRows(TWO_REPO_TASKS))
    const h = makeHarness(ids)
    h.ctrl.pressShiftG()
    h.ctrl.selectCurrent()
    expect(h.state().selected).toEqual([ids[ids.length - 1]])

    // gg back to the top.
    h.ctrl.pressG()
    h.ctrl.pressG()
    h.ctrl.selectCurrent()
    expect(h.state().selected[h.state().selected.length - 1]).toBe(ids[0])
  })
})

// ---------------------------------------------------------------------
// Selection: prove the contract Stream E will rely on. The
// `selectedId` accessor is a parent-owned signal — we don't render
// here, but we assert the row metadata that drives the visual
// distinction is correct: the task row carrying the selected id is the
// one whose `task.id === selectedId`. The component highlights that
// row separately from the cursor row.
// ---------------------------------------------------------------------

describe("selectedId visual contract", () => {
  test("buildRows surfaces the selected task as a regular task row whose id matches", () => {
    const rows = buildRows(TWO_REPO_TASKS)
    const selectedId = "04"
    const matches = rows.filter((r) => r.kind === "task" && r.task.id === selectedId)
    expect(matches).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------
// Status-stable contract: a task transitioning status (e.g. backlog →
// done) stays under the same repo header — its row must NOT relocate
// across header boundaries when status changes. This is the load-bearing
// difference between the old status-grouped sidebar and the new repo-
// grouped one. (Wave 4 W4.A behavioral guarantee.)
// ---------------------------------------------------------------------

describe("repo grouping is stable across status transitions", () => {
  test("a task moving from backlog to done stays under the same repo header", () => {
    const beforeTasks: Task[] = [
      makeTask("a", "task one", "backlog", "/repos/foo"),
      makeTask("b", "task two", "backlog", "/repos/bar"),
    ]
    const afterTasks: Task[] = [
      makeTask("a", "task one", "done", "/repos/foo"),
      makeTask("b", "task two", "backlog", "/repos/bar"),
    ]
    const before = buildRows(beforeTasks)
    const after = buildRows(afterTasks)

    // Same number of rows.
    expect(before.length).toBe(after.length)

    // Same repo headers in the same order with the same counts.
    const beforeHeaders = before.filter((r) => r.kind === "repo-header")
    const afterHeaders = after.filter((r) => r.kind === "repo-header")
    expect(afterHeaders.map((h) => (h.kind === "repo-header" ? h.label : null))).toEqual(
      beforeHeaders.map((h) => (h.kind === "repo-header" ? h.label : null)),
    )
    expect(afterHeaders.map((h) => (h.kind === "repo-header" ? h.count : null))).toEqual(
      beforeHeaders.map((h) => (h.kind === "repo-header" ? h.count : null)),
    )

    // Task `a` lives at the same flat index after the transition (same
    // relative position under its repo header).
    const beforeA = before.find((r) => r.kind === "task" && r.task.id === "a")
    const afterA = after.find((r) => r.kind === "task" && r.task.id === "a")
    if (!beforeA || beforeA.kind !== "task" || !afterA || afterA.kind !== "task") {
      throw new Error("task `a` missing from rows")
    }
    expect(afterA.flatIndex).toBe(beforeA.flatIndex)
  })
})

// ---------------------------------------------------------------------
// focused gating: when the parent passes focused=false, the bindings
// hook publishes `enabled: false` to useBindings — pressed keys are
// discarded by the keymap layer, so onSelect is never called. We can't
// reach useBindings without a renderer, but we can verify the
// controller itself is purely stateful (the gating is a wrapper on
// top). The contract: the controller does what it's told; the hook
// ensures the controller isn't told anything when unfocused.
// ---------------------------------------------------------------------

describe("focus-gating contract", () => {
  test("the controller emits onSelect every time selectCurrent is called", () => {
    // We're documenting that gating is the hook's job, not the
    // controller's. If a future refactor moves gating into the
    // controller, this test should be updated.
    const h = makeHarness(["a", "b"])
    h.ctrl.selectCurrent()
    h.ctrl.selectCurrent()
    expect(h.state().selected).toEqual(["a", "a"])
  })
})

// Touch the vi import for parity with future tests that may need
// fake timers (e.g. validating real-clock chord expiry against a
// mocked Date.now). Keeping it imported avoids reorder churn later.
void vi
