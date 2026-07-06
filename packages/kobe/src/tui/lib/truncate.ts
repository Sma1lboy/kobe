/**
 * One owner for ellipsis truncation of compact row labels (task titles, branch
 * chips, filesystem paths). Two directions, one rule each:
 *
 * - {@link truncateEnd} keeps the PREFIX (`feat/long-branch…`) — the front of a
 *   title/branch carries the type/scope the eye scans for.
 * - {@link truncateStart} keeps the TAIL (`…r/Sidebar.tsx`) — a path's leaf is
 *   the part that disambiguates.
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

/** Truncate keeping the tail, with a leading ellipsis when clipped. */
export function truncateStart(s: string, max: number): string {
  if (max <= 0) return ""
  const points = [...s]
  if (points.length <= max) return s
  return `…${points.slice(points.length - Math.max(0, max - 1)).join("")}`
}
