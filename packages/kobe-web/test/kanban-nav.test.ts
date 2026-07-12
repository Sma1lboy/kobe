import { describe, expect, it } from "vitest"
import { moveKanbanSelection } from "../src/lib/kanban-nav.ts"

/**
 * Kanban keyboard-navigation contract: arrows move within/across columns,
 * empty columns are skipped, row position clamps to the target column's
 * length, and a missing selection re-anchors on the first visible card —
 * so arrow keys always land somewhere on a non-empty board.
 */

const board = [
  [1, 2, 3], // open
  [], // doing (empty — must be skipped)
  [4, 5], // hold
  [6], // done
]

describe("moveKanbanSelection", () => {
  it("anchors on the first card of the first non-empty column when nothing is selected", () => {
    expect(moveKanbanSelection(board, null, "down")).toBe(1)
    expect(moveKanbanSelection([[], [7]], null, "right")).toBe(7)
  })

  it("re-anchors when the selected id vanished from the board", () => {
    expect(moveKanbanSelection(board, 99, "down")).toBe(1)
  })

  it("returns null on an empty board", () => {
    expect(moveKanbanSelection([[], []], null, "down")).toBeNull()
  })

  it("moves up/down within a column and clamps at the edges", () => {
    expect(moveKanbanSelection(board, 1, "down")).toBe(2)
    expect(moveKanbanSelection(board, 3, "down")).toBe(3)
    expect(moveKanbanSelection(board, 2, "up")).toBe(1)
    expect(moveKanbanSelection(board, 1, "up")).toBe(1)
  })

  it("moves right past an empty column, keeping the row", () => {
    expect(moveKanbanSelection(board, 2, "right")).toBe(5)
  })

  it("clamps the row when the target column is shorter", () => {
    expect(moveKanbanSelection(board, 3, "right")).toBe(5)
    expect(moveKanbanSelection(board, 5, "right")).toBe(6)
  })

  it("moves left symmetrically and stays put at the board edge", () => {
    expect(moveKanbanSelection(board, 4, "left")).toBe(1)
    expect(moveKanbanSelection(board, 1, "left")).toBe(1)
    expect(moveKanbanSelection(board, 6, "right")).toBe(6)
  })
})
