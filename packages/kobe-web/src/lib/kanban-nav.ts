/**
 * Pure keyboard-navigation helper for kanban surfaces: given the board's
 * columns as ordered id lists, move a selection up/down within a column or
 * left/right across columns (empty columns are skipped, the row index is
 * clamped). A missing/stale selection re-anchors on the first card of the
 * first non-empty column, so arrows always land somewhere visible.
 */

export type KanbanDirection = "up" | "down" | "left" | "right"

export function moveKanbanSelection(
  columns: ReadonlyArray<ReadonlyArray<number>>,
  currentId: number | null,
  dir: KanbanDirection,
): number | null {
  const firstVisible = columns.find((column) => column.length > 0)?.[0] ?? null
  if (currentId == null) return firstVisible
  let col = -1
  let row = -1
  for (const [c, column] of columns.entries()) {
    const r = column.indexOf(currentId)
    if (r !== -1) {
      col = c
      row = r
      break
    }
  }
  if (col === -1) return firstVisible
  if (dir === "up" || dir === "down") {
    const column = columns[col]
    const next = dir === "up" ? row - 1 : row + 1
    return column[Math.max(0, Math.min(next, column.length - 1))] ?? currentId
  }
  const step = dir === "left" ? -1 : 1
  for (let c = col + step; c >= 0 && c < columns.length; c += step) {
    const column = columns[c]
    if (column.length === 0) continue
    return column[Math.min(row, column.length - 1)] ?? currentId
  }
  return currentId
}
