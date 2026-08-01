/**
 * Pure viewport-slicing math for the terminal pane (extracted from
 * Terminal.tsx so vitest can pin it — revival checklist #4). The pane
 * keeps the full snapshot in memory and renders only this window.
 */

export interface ViewportRange {
  readonly start: number
  readonly end: number
}

export type ViewportScrollState = {
  readonly fallbackOffset: number
  readonly anchor: { readonly epoch: number; readonly topLine: number } | null
}

export type ViewportWindow = { readonly epoch: number; readonly startLine: number }

export const FOLLOW_VIEWPORT: ViewportScrollState = { fallbackOffset: 0, anchor: null }

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

/** Resolve a historical viewport against a bounded snapshot that may slide while output streams. */
export function resolveViewportScrollOffset(
  total: number,
  height: number,
  state: ViewportScrollState,
  window: ViewportWindow | null,
): number {
  const max = Math.max(0, total - Math.max(1, height))
  const fallback = Math.min(max, Math.max(0, state.fallbackOffset))
  if (!state.anchor || !window || state.anchor.epoch !== window.epoch) return fallback
  const top = state.anchor.topLine - window.startLine
  if (top <= 0) return max
  return Math.min(max, Math.max(0, total - (top + Math.max(1, height))))
}

/** Apply a user scroll and pin the resulting top row when the backend exposes stable line ids. */
export function moveViewportScroll(
  state: ViewportScrollState,
  total: number,
  height: number,
  lines: number,
  window: ViewportWindow | null,
): ViewportScrollState {
  const current = resolveViewportScrollOffset(total, height, state, window)
  const max = Math.max(0, total - Math.max(1, height))
  const next = Math.min(max, Math.max(0, current - lines))
  if (next === 0) return FOLLOW_VIEWPORT
  const range = computeViewport(total, height, next)
  const anchor = window ? { epoch: window.epoch, topLine: window.startLine + range.start } : null
  return { fallbackOffset: next, anchor }
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
