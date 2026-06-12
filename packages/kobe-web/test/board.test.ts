import { afterEach, describe, expect, it } from "vitest"
import {
  applyBoardOverrides,
  BOARD_COLUMNS,
  boardCardCount,
  buildBoard,
  compareCards,
  effectivePosition,
  isBoardTask,
  isDroppableColumn,
  POSITION_STEP,
  positionBetween,
  reconcileOverrides,
  renormalizedMoves,
  TERMINAL_COLUMN_CAP,
} from "../src/lib/board.ts"
import {
  clearPositionOverride,
  clearStatusOverride,
  getBoardState,
  reconcileBoardOverrides,
  resetBoardStateForTest,
  setBoardQuery,
  setPositionOverrides,
  setStatusOverride,
} from "../src/lib/board-state.ts"
import type { Task } from "../src/lib/types.ts"

/**
 * Kanban column math. The load-bearing rules: columns bind to the persisted
 * Task.status only; archived/main rows never enter the board; error/canceled
 * columns fold away when empty; an unknown status must never silently drop a
 * card (it becomes a trailing dynamic column); within a column pinned floats,
 * then newest update first.
 */

const task = (over: Partial<Task>): Task =>
  ({
    id: over.id ?? "t",
    kind: "task",
    pinned: false,
    archived: false,
    status: "backlog",
    title: "",
    ...over,
  }) as Task

const columnKeys = (tasks: Task[]) => buildBoard(tasks).map((c) => c.key)
const columnIds = (tasks: Task[], key: string) =>
  buildBoard(tasks)
    .find((c) => c.key === key)
    ?.tasks.map((t) => t.id)

describe("isBoardTask", () => {
  it("keeps regular worktree tasks", () => {
    expect(isBoardTask(task({}))).toBe(true)
  })
  it("excludes archived tasks and main project rows", () => {
    expect(isBoardTask(task({ archived: true }))).toBe(false)
    expect(isBoardTask(task({ kind: "main" }))).toBe(false)
  })
})

describe("buildBoard — column visibility", () => {
  it("shows the four primary columns even when empty", () => {
    expect(columnKeys([])).toEqual([
      "backlog",
      "in_progress",
      "in_review",
      "done",
    ])
  })

  it("folds error/canceled away when empty, shows them when occupied", () => {
    expect(columnKeys([task({ id: "e", status: "error" })])).toEqual([
      "backlog",
      "in_progress",
      "in_review",
      "done",
      "error",
    ])
    expect(columnKeys([task({ id: "c", status: "canceled" })])).toContain(
      "canceled",
    )
  })

  it("keeps canonical order per BOARD_COLUMNS", () => {
    const canonical = BOARD_COLUMNS.map((c) => c.key)
    const keys = columnKeys([
      task({ id: "a", status: "canceled" }),
      task({ id: "b", status: "error" }),
    ])
    expect(keys).toEqual(canonical.filter((k) => keys.includes(k)))
  })
})

describe("buildBoard — bucketing", () => {
  it("buckets by persisted status and never drops unknown statuses", () => {
    const tasks = [
      task({ id: "b1" }),
      task({ id: "p1", status: "in_progress" }),
      task({ id: "weird", status: "qa_hold" }),
    ]
    expect(columnIds(tasks, "backlog")).toEqual(["b1"])
    expect(columnIds(tasks, "in_progress")).toEqual(["p1"])
    // Unknown status → trailing dynamic column titled by the raw key.
    const board = buildBoard(tasks)
    const extra = board[board.length - 1]
    expect(extra.key).toBe("qa_hold")
    expect(extra.title).toBe("qa_hold")
    expect(extra.tasks.map((t) => t.id)).toEqual(["weird"])
  })

  it("treats a missing status as backlog and excludes non-board tasks", () => {
    const tasks = [
      task({ id: "nostatus", status: "" }),
      task({ id: "arch", archived: true }),
      task({ id: "proj", kind: "main" }),
    ]
    expect(columnIds(tasks, "backlog")).toEqual(["nostatus"])
    expect(boardCardCount(buildBoard(tasks))).toBe(1)
  })
})

describe("compareCards — within a column", () => {
  it("floats pinned, then explicit position, default newest-created-first", () => {
    const old = task({ id: "old", createdAt: "2026-06-01T00:00:00Z" })
    const fresh = task({ id: "fresh", createdAt: "2026-06-10T00:00:00Z" })
    const pinnedOld = task({
      id: "pin",
      pinned: true,
      createdAt: "2026-05-01T00:00:00Z",
    })
    expect(columnIds([old, fresh, pinnedOld], "backlog")).toEqual([
      "pin",
      "fresh",
      "old",
    ])
    // An explicit position outranks the created-time default: positions are
    // small numbers, defaults are huge negative epochs, so positioned cards
    // sort after a never-dragged newest card only if placed there.
    const placedFirst = task({
      id: "placed",
      position: -9e12, // dragged above everything
      createdAt: "2026-01-01T00:00:00Z",
    })
    expect(columnIds([old, fresh, placedFirst], "backlog")[0]).toBe("placed")
    // Identical keys: higher id first (deterministic).
    const a = task({ id: "a", createdAt: "2026-06-01T00:00:00Z" })
    const b = task({ id: "b", createdAt: "2026-06-01T00:00:00Z" })
    expect(compareCards(a, b)).toBeGreaterThan(0)
  })

  it("created-time default is STABLE while engines run (ignores updatedAt)", () => {
    const a = task({
      id: "a",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-11T09:00:00Z",
    })
    const b = task({
      id: "b",
      createdAt: "2026-06-02T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    })
    // b is newer-created → first, even though a was updated more recently.
    expect(columnIds([a, b], "backlog")).toEqual(["b", "a"])
  })
})

describe("positionBetween / renormalizedMoves — drop math", () => {
  const at = (id: string, position: number) => task({ id, position })

  it("midpoint between neighbors, STEP beyond edges, 0 into empty", () => {
    expect(positionBetween(undefined, undefined)).toBe(0)
    expect(positionBetween(at("p", 1000), undefined)).toBe(
      1000 + POSITION_STEP,
    )
    expect(positionBetween(undefined, at("n", 1000))).toBe(
      1000 - POSITION_STEP,
    )
    expect(positionBetween(at("p", 1000), at("n", 2000))).toBe(1500)
  })

  it("returns null when float precision collapses the midpoint", () => {
    // Equal keys: no strictly-between value exists.
    expect(positionBetween(at("p", 1000), at("n", 1000))).toBeNull()
    // Adjacent doubles (2^-43 is one ULP at 1000): the midpoint rounds onto
    // a neighbor, so insertion must renormalize instead.
    expect(positionBetween(at("p", 1000), at("n", 1000 + 2 ** -43))).toBeNull()
  })

  it("renormalizedMoves spaces the whole column by POSITION_STEP", () => {
    const moves = renormalizedMoves([task({ id: "x" }), task({ id: "y" })])
    expect(moves).toEqual([
      { taskId: "x", position: POSITION_STEP },
      { taskId: "y", position: 2 * POSITION_STEP },
    ])
  })
})

describe("buildBoard — terminal-column cap", () => {
  it("caps done at TERMINAL_COLUMN_CAP with a hidden count, never caps active columns", () => {
    const done = Array.from({ length: TERMINAL_COLUMN_CAP + 5 }, (_, i) =>
      task({ id: `d${String(i).padStart(3, "0")}`, status: "done" }),
    )
    const active = Array.from({ length: TERMINAL_COLUMN_CAP + 5 }, (_, i) =>
      task({ id: `a${String(i).padStart(3, "0")}`, status: "in_progress" }),
    )
    const board = buildBoard([...done, ...active])
    const doneCol = board.find((c) => c.key === "done")
    const activeCol = board.find((c) => c.key === "in_progress")
    expect(doneCol?.tasks).toHaveLength(TERMINAL_COLUMN_CAP)
    expect(doneCol?.hiddenCount).toBe(5)
    expect(activeCol?.tasks).toHaveLength(TERMINAL_COLUMN_CAP + 5)
    expect(activeCol?.hiddenCount).toBe(0)
  })
})

describe("effectivePosition", () => {
  it("prefers the explicit position and falls back to -createdMs", () => {
    expect(effectivePosition(task({ position: 7 }))).toBe(7)
    const created = "2026-06-01T00:00:00Z"
    expect(effectivePosition(task({ createdAt: created }))).toBe(
      -Date.parse(created),
    )
    expect(effectivePosition(task({ createdAt: "garbage" }))).toBe(0)
  })
})

describe("board-state — module store filter", () => {
  afterEach(() => resetBoardStateForTest())

  it("holds the filter at module level so it survives view unmounts", () => {
    setBoardQuery("auth")
    expect(getBoardState().query).toBe("auth")
  })

  it("keeps the same snapshot reference for a no-op set (React skip)", () => {
    setBoardQuery("x")
    const before = getBoardState()
    setBoardQuery("x")
    expect(getBoardState()).toBe(before)
  })

  it("resets for test isolation", () => {
    setBoardQuery("y")
    resetBoardStateForTest()
    expect(getBoardState().query).toBe("")
  })
})

describe("applyBoardOverrides — optimistic paint", () => {
  it("returns the same reference with no overrides", () => {
    const tasks = [task({ id: "a" })]
    expect(applyBoardOverrides(tasks, {})).toBe(tasks)
  })

  it("paints pending status AND position without mutating the source", () => {
    const a = task({ id: "a", status: "backlog" })
    const painted = applyBoardOverrides([a], {
      a: { status: "in_review", position: 512 },
    })
    expect(painted[0].status).toBe("in_review")
    expect(painted[0].position).toBe(512)
    expect(a.status).toBe("backlog")
    expect(a.position).toBeUndefined()
  })
})

describe("reconcileOverrides — R4 precise-clear rule", () => {
  it("keeps an in-flight override across an UNRELATED snapshot", () => {
    const overrides = { a: { status: "in_review" } }
    // Snapshot where some other task changed; a is still backlog.
    const next = reconcileOverrides(overrides, [
      task({ id: "a", status: "backlog" }),
      task({ id: "b", status: "done" }),
    ])
    expect(next).toBe(overrides) // same ref: nothing cleared, React skips
  })

  it("clears once the snapshot confirms the expected status", () => {
    const next = reconcileOverrides({ a: { status: "in_review" } }, [
      task({ id: "a", status: "in_review" }),
    ])
    expect(next).toEqual({})
  })

  it("clears PER FIELD: a confirmed status keeps an in-flight position", () => {
    const next = reconcileOverrides(
      { a: { status: "in_review", position: 512 } },
      [task({ id: "a", status: "in_review" })], // position not yet applied
    )
    expect(next).toEqual({ a: { position: 512 } })
  })

  it("drops the override when the task vanished mid-flight", () => {
    expect(reconcileOverrides({ gone: { status: "done" } }, [])).toEqual({})
  })
})

describe("board-state — override store", () => {
  afterEach(() => resetBoardStateForTest())

  it("records and rolls back a failed drop", () => {
    setStatusOverride("a", "in_review")
    expect(getBoardState().overrides).toEqual({ a: { status: "in_review" } })
    clearStatusOverride("a", "in_review")
    expect(getBoardState().overrides).toEqual({})
  })

  it("an older RPC's rollback must not clear a newer drag's override", () => {
    setStatusOverride("a", "in_review") // first drag (will fail)
    setStatusOverride("a", "done") // user drags again before the reject
    clearStatusOverride("a", "in_review") // first RPC rejects
    expect(getBoardState().overrides).toEqual({ a: { status: "done" } })
  })

  it("rolling back one field keeps the other", () => {
    setStatusOverride("a", "in_review")
    setPositionOverrides([{ taskId: "a", position: 256 }])
    clearPositionOverride("a", 256)
    expect(getBoardState().overrides).toEqual({ a: { status: "in_review" } })
  })

  it("reconciles against an authoritative task list", () => {
    setStatusOverride("a", "in_review")
    setStatusOverride("b", "done")
    reconcileBoardOverrides([
      task({ id: "a", status: "in_review" }), // confirmed → clear
      task({ id: "b", status: "backlog" }), // still in flight → keep
    ])
    expect(getBoardState().overrides).toEqual({ b: { status: "done" } })
  })
})

describe("isDroppableColumn", () => {
  it("accepts canonical lifecycle columns, rejects dynamic unknowns", () => {
    expect(isDroppableColumn("in_review")).toBe(true)
    expect(isDroppableColumn("canceled")).toBe(true)
    expect(isDroppableColumn("qa_hold")).toBe(false)
  })
})
