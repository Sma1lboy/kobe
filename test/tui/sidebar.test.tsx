/**
 * Stream F + W4.A → W4.5 — Sidebar pane component tests.
 *
 * These exercise the sidebar's pure layout + navigation logic. The full
 * Solid component (`Sidebar`) is rendered through `@opentui/core`'s
 * native bindings under Bun at runtime; vitest's worker pool runs in
 * Node and cannot load opentui's bun-ffi-structs, so a `testRender`
 * roundtrip is not possible without restructuring the project's test
 * runner. We mitigate that by:
 *
 *   1. Splitting all rendering-independent logic into pure functions
 *      (`buildRows`, `filterByView`, `flattenIds`,
 *      `createSidebarController`) and asserting on those directly.
 *   2. Letting the behavior tests (PTY-driven, real binary) prove the
 *      visible end-to-end rendering — `sidebar-delete.test.ts` and
 *      `sidebar-archive.test.ts` exercise the sidebar against the real
 *      `bun run dev` process.
 *
 * Wave 4.5: repo grouping was reverted. The sidebar is now a flat task
 * list with two views — "Working session" (active) and "Archives" —
 * switchable via `[` / `]`. Per-task metadata (repo / branch /
 * worktree path) shows in the topbar instead. `a` toggles a task's
 * `archived` flag, which moves it between views. These tests assert
 * the new flat / view-filtered contract.
 */

import { GG_CHORD_TIMEOUT_MS, createSidebarController } from "@/tui/panes/sidebar/controller"
// We import directly from the leaf modules (not the barrel
// `@/tui/panes/sidebar`) because the barrel re-exports the JSX
// component, which transitively drags in `@opentui/core`. opentui's
// native bindings require Bun's runtime; vitest uses Node's, which
// would crash module init with `Unknown file extension ".scm"`. The
// pure logic lives in `./groups` and `./controller` and has no opentui
// imports — that's what we exercise here.
import { buildRows, filterByView, flattenIds } from "@/tui/panes/sidebar/groups"
import type { Task, TaskStatus } from "@/types"
import { toTaskId } from "@/types"
import { describe, expect, test } from "vitest"

/**
 * Build a minimal {@link Task} for tests. ULIDs are not required — the
 * sidebar uses ids only for equality and selection, not for sorting.
 *
 * `repo` defaults to `/tmp/repo` so existing call sites stay terse;
 * tests that exercise per-task metadata override it explicitly.
 */
function makeTask(id: string, title: string, status: TaskStatus, repo = "/tmp/repo", archived = false): Task {
  const now = "2026-05-08T00:00:00.000Z"
  const tabId = `tab-${id}`
  return {
    id: toTaskId(id),
    title,
    repo,
    branch: `kobe/${id}`,
    worktreePath: `${repo}/.claude/worktrees/${id}`,
    sessionId: null,
    tabs: [{ id: tabId, sessionId: null, createdAt: now }],
    activeTabId: tabId,
    status,
    archived,
    createdAt: now,
    updatedAt: now,
  }
}

const ACTIVE_TASKS: Task[] = [
  makeTask("01", "fix login redirect", "in_progress"),
  makeTask("02", "refactor auth", "backlog"),
  makeTask("03", "add password reset", "backlog"),
]
const ARCHIVED_TASKS: Task[] = [
  makeTask("a1", "old experiment", "done", "/tmp/repo", true),
  makeTask("a2", "ditched approach", "done", "/tmp/repo", true),
]
const MIXED_TASKS: Task[] = [...ACTIVE_TASKS, ...ARCHIVED_TASKS]

// ---------------------------------------------------------------------
// filterByView — pure view filter
// ---------------------------------------------------------------------

describe("filterByView", () => {
  test("returns only non-archived tasks for the active view", () => {
    const out = filterByView(MIXED_TASKS, "active")
    expect(out.map((t) => t.id)).toEqual(["01", "02", "03"])
  })

  test("returns only archived tasks for the archived view", () => {
    const out = filterByView(MIXED_TASKS, "archived")
    expect(out.map((t) => t.id)).toEqual(["a1", "a2"])
  })

  test("preserves input order within a view", () => {
    const interleaved: Task[] = [
      makeTask("a", "A", "backlog", "/tmp/r", false),
      makeTask("b", "B", "done", "/tmp/r", true),
      makeTask("c", "C", "backlog", "/tmp/r", false),
      makeTask("d", "D", "done", "/tmp/r", true),
    ]
    expect(filterByView(interleaved, "active").map((t) => t.id)).toEqual(["a", "c"])
    expect(filterByView(interleaved, "archived").map((t) => t.id)).toEqual(["b", "d"])
  })

  test("handles an empty list", () => {
    expect(filterByView([], "active")).toEqual([])
    expect(filterByView([], "archived")).toEqual([])
  })
})

// ---------------------------------------------------------------------
// buildRows — visible row layout
// ---------------------------------------------------------------------

describe("buildRows", () => {
  test("returns an empty list for empty input", () => {
    expect(buildRows([], "active")).toEqual([])
    expect(buildRows([], "archived")).toEqual([])
  })

  test("emits one task row per active task in the active view", () => {
    const rows = buildRows(MIXED_TASKS, "active")
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ kind: "task", task: { id: "01" }, flatIndex: 0 })
    expect(rows[1]).toMatchObject({ kind: "task", task: { id: "02" }, flatIndex: 1 })
    expect(rows[2]).toMatchObject({ kind: "task", task: { id: "03" }, flatIndex: 2 })
  })

  test("emits one task row per archived task in the archived view", () => {
    const rows = buildRows(MIXED_TASKS, "archived")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: "task", task: { id: "a1" }, flatIndex: 0 })
    expect(rows[1]).toMatchObject({ kind: "task", task: { id: "a2" }, flatIndex: 1 })
  })

  test("flatIndex on task rows is monotonically increasing within a view", () => {
    const rows = buildRows(MIXED_TASKS, "active")
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (r) expect(r.flatIndex).toBe(i)
    }
  })

  test("does not emit a synthetic placeholder for an empty view", () => {
    // Two archived tasks but the active view is empty — should yield
    // an empty array; the renderer is responsible for the empty-state
    // copy.
    const rows = buildRows(ARCHIVED_TASKS, "active")
    expect(rows).toEqual([])
  })
})

describe("flattenIds", () => {
  test("returns task ids in render order", () => {
    const rows = buildRows(MIXED_TASKS, "active")
    expect(flattenIds(rows)).toEqual(["01", "02", "03"])
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
// View / cursor integration
// ---------------------------------------------------------------------

describe("cursor navigation over the flat list", () => {
  test("j/k navigation walks task ids in order", () => {
    const ids = flattenIds(buildRows(ACTIVE_TASKS, "active"))
    const h = makeHarness(ids)
    expect(h.state().cursor).toBe(0)
    expect(ids[h.state().cursor]).toBe("01")
    h.ctrl.moveDown()
    expect(ids[h.state().cursor]).toBe("02")
    h.ctrl.moveDown()
    expect(ids[h.state().cursor]).toBe("03")
  })

  test("enter on the cursor row calls onSelect with the right id", () => {
    const ids = flattenIds(buildRows(ACTIVE_TASKS, "active"))
    const h = makeHarness(ids)
    h.ctrl.pressShiftG()
    h.ctrl.selectCurrent()
    expect(h.state().selected).toEqual([ids[ids.length - 1]])
  })
})

// ---------------------------------------------------------------------
// Selected id contract
// ---------------------------------------------------------------------

describe("selectedId visual contract", () => {
  test("buildRows surfaces the selected task as a regular task row whose id matches", () => {
    const rows = buildRows(ACTIVE_TASKS, "active")
    const selectedId = "02"
    const matches = rows.filter((r) => r.task.id === selectedId)
    expect(matches).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------
// Archive flag drives view membership
// ---------------------------------------------------------------------

describe("archived flag drives view membership", () => {
  test("flipping archived moves the row from active to archived view", () => {
    const beforeTasks: Task[] = [
      makeTask("a", "task one", "done", "/tmp/r", false),
      makeTask("b", "task two", "backlog", "/tmp/r", false),
    ]
    const afterTasks: Task[] = [
      makeTask("a", "task one", "done", "/tmp/r", true),
      makeTask("b", "task two", "backlog", "/tmp/r", false),
    ]
    const beforeActive = buildRows(beforeTasks, "active")
    const afterActive = buildRows(afterTasks, "active")
    const afterArchived = buildRows(afterTasks, "archived")

    expect(beforeActive.map((r) => r.task.id)).toEqual(["a", "b"])
    expect(afterActive.map((r) => r.task.id)).toEqual(["b"])
    expect(afterArchived.map((r) => r.task.id)).toEqual(["a"])
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
    const h = makeHarness(["a", "b"])
    h.ctrl.selectCurrent()
    h.ctrl.selectCurrent()
    expect(h.state().selected).toEqual(["a", "a"])
  })
})
