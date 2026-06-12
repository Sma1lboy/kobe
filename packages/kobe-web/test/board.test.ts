import { afterEach, describe, expect, it } from "vitest"
import {
  BOARD_COLUMNS,
  boardCardCount,
  buildBoard,
  compareCards,
  isBoardTask,
} from "../src/lib/board.ts"
import {
  getBoardState,
  resetBoardStateForTest,
  setBoardQuery,
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
  it("floats pinned, then newest update, id as stable tiebreak", () => {
    const old = task({ id: "old", updatedAt: "2026-06-01T00:00:00Z" })
    const fresh = task({ id: "fresh", updatedAt: "2026-06-10T00:00:00Z" })
    const pinnedOld = task({
      id: "pin",
      pinned: true,
      updatedAt: "2026-05-01T00:00:00Z",
    })
    expect(columnIds([old, fresh, pinnedOld], "backlog")).toEqual([
      "pin",
      "fresh",
      "old",
    ])
    // Identical timestamps: higher id first (deterministic, matches rail).
    const a = task({ id: "a", updatedAt: "2026-06-01T00:00:00Z" })
    const b = task({ id: "b", updatedAt: "2026-06-01T00:00:00Z" })
    expect(compareCards(a, b)).toBeGreaterThan(0)
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
