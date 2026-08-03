/**
 * Tail-truncate a path to fit a fixed-width slot: keep the END (the filename is
 * the useful part) and prefix an ellipsis. A path within the budget is returned
 * unchanged. Shared so the rail and the diff file list truncate identically.
 *
 * The result is at most `max` code points: the leading `…` plus the last
 * `max - 1`. Iterates by code POINT (`[...path]`), not UTF-16 code unit: a
 * plain `.slice` can bisect a surrogate pair (an emoji or astral-plane char in
 * a filename) and render a `�` replacement glyph. `max` stays an approximate
 * cell budget — a code point can be a wide CJK glyph — matching the TUI's
 * `truncateStart`.
 */
export function tailPath(path: string, max = 36): string {
  const points = [...path]
  if (points.length <= max) return path
  return `…${points.slice(points.length - max + 1).join("")}`
}
