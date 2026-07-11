/**
 * One owner for ellipsis truncation of compact row labels (task titles, branch
 * chips, filesystem paths). Two directions, one rule each:
 *
 * - {@link truncateEnd} keeps the PREFIX (`feat/long-branch…`) — the front of a
 *   title/branch carries the type/scope the eye scans for.
 * - {@link truncateStart} keeps the TAIL (`…r/Sidebar.tsx`) — a path's leaf is
 *   the part that disambiguates.
 * - {@link truncateEndCells} is truncateEnd with a display-CELL budget for
 *   labels laid out in cells (a wide CJK glyph spends 2 of the budget).
 *
 * Both iterate by code POINT (`[...s]`), not UTF-16 code unit: a plain `.slice`
 * can bisect a surrogate pair (emoji / astral char in a title or filename) and
 * render a `�` replacement glyph. Counting by code point never splits a
 * character — the correctness floor. `max` is still an approximate *cell*
 * budget (a code point can be a wide CJK glyph), a known, accepted imprecision
 * shared by these labels; sizing tooltips uses the precise width measurers.
 *
 * Shared boundary rule: `max <= 0` (no room) yields `""`; a string that already
 * fits is returned unchanged; otherwise one cell is reserved for the `…`.
 */

/** Truncate keeping the prefix, with a trailing ellipsis when clipped. */
export function truncateEnd(s: string, max: number): string {
  if (max <= 0) return ""
  const points = [...s]
  if (points.length <= max) return s
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`
}

/**
 * {@link truncateEnd} against a display-CELL budget. `cellsOf` maps a code
 * point to its cell width (injected — e.g. `approxCharCells` from
 * `src/lib/display-width` — so this module stays dependency-free). Same
 * boundary rule: no room → `""`, fits → unchanged, else one cell is
 * reserved for the `…` and no glyph is ever split across the budget.
 */
export function truncateEndCells(s: string, maxCells: number, cellsOf: (cp: number) => number): string {
  if (maxCells <= 0) return ""
  let total = 0
  for (const ch of s) total += cellsOf(ch.codePointAt(0) ?? 0)
  if (total <= maxCells) return s
  let used = 0
  let out = ""
  for (const ch of s) {
    const w = cellsOf(ch.codePointAt(0) ?? 0)
    if (used + w > maxCells - 1) break // reserve 1 cell for the ellipsis
    used += w
    out += ch
  }
  return `${out}…`
}

/** Truncate keeping the tail, with a leading ellipsis when clipped. */
export function truncateStart(s: string, max: number): string {
  if (max <= 0) return ""
  const points = [...s]
  if (points.length <= max) return s
  return `…${points.slice(points.length - Math.max(0, max - 1)).join("")}`
}
