/**
 * text-match — the one substring-search mechanic the SPA's text filters share.
 *
 * The rail (matchesTask), the board (filterBoardCards), and the transcript
 * (messageMatchesQuery) each independently re-implemented the same kernel:
 * trim + lowercase the query, treat blank as "match everything", else
 * case-insensitive substring. Only the TEXT PROJECTION differs per surface
 * (which fields of the item get searched) — that legitimately stays per-caller;
 * the mechanic lives here so the blank-query and case rules can't drift between
 * search boxes.
 *
 * NOT a home for the other two matchers, which are different algorithms:
 * `diff-filter.ts` (anchored glob + `!` negation) and `fuzzy.ts` (subsequence
 * ranking for the command palette).
 */

/** Case-insensitive substring test. The query is trimmed; a blank/whitespace
 *  query matches everything (the no-filter case). */
export function textMatchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return haystack.toLowerCase().includes(q)
}
