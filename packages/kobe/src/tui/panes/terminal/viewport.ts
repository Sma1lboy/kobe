/**
 * Pure viewport-slicing math for the terminal pane (extracted from
 * Terminal.tsx so vitest can pin it — revival checklist #4). The pane
 * keeps the full snapshot in memory and renders only this window.
 */

export interface ViewportRange {
  readonly start: number
  readonly end: number
}

/**
 * Visible row window for a buffer of `total` rows in a body of `height`
 * rows, scrolled `offset` lines back into history. `offset` 0 follows the
 * bottom (the last `height` rows); positive offsets move the window up,
 * clamping at the top so the window never underflows.
 */
export function computeViewport(total: number, height: number, offset: number): ViewportRange {
  const h = Math.max(1, height)
  const end = Math.max(0, total - Math.max(0, offset))
  const start = Math.max(0, end - h)
  return { start, end }
}

/**
 * Cursor position within the viewport, or null when the cursor is
 * outside the window or the user has scrolled back (a historical
 * viewport has no live cursor).
 */
export function viewportCursor(
  cursor: { x: number; y: number } | null,
  offset: number,
  range: ViewportRange,
): { x: number; y: number } | null {
  if (!cursor || offset !== 0) return null
  if (cursor.y < range.start || cursor.y >= range.end) return null
  return { x: cursor.x, y: cursor.y - range.start }
}
