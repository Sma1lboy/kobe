export interface ViewportRange {
  readonly start: number
  readonly end: number
}

export function computeViewport(total: number, height: number, offset: number): ViewportRange {
  const h = Math.max(1, height)
  const end = Math.max(0, total - Math.max(0, offset))
  const start = Math.max(0, end - h)
  return { start, end }
}

export function viewportCursor(
  cursor: { x: number; y: number } | null,
  offset: number,
  range: ViewportRange,
): { x: number; y: number } | null {
  if (!cursor || offset !== 0) return null
  if (cursor.y < range.start || cursor.y >= range.end) return null
  return { x: cursor.x, y: cursor.y - range.start }
}
