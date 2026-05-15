/**
 * Fuzzy match for the sidebar's `/`-search.
 *
 * Algorithm: case-insensitive subsequence test. Every character of the
 * query must appear in the haystack in order, gaps allowed. No scoring
 * — the caller preserves the original ordering of survivors, which
 * matches the sidebar's existing "main → pinned → regular" partition.
 *
 *   fuzzyMatch("kbe", "kobe")              → true
 *   fuzzyMatch("kbe", "berserk")           → false  (order matters)
 *   fuzzyMatch("CSK", "closure-stack-k8s") → true   (case-insensitive)
 *   fuzzyMatch("", anything)               → true   (empty query passes)
 *
 * Pure: no Solid, no opentui, no fs. Unit-tested at
 * `test/tui/sidebar/fuzzy.test.ts`.
 */
export function fuzzyMatch(query: string, haystack: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const h = haystack.toLowerCase()
  let qi = 0
  for (let hi = 0; hi < h.length && qi < q.length; hi++) {
    if (h.charCodeAt(hi) === q.charCodeAt(qi)) qi++
  }
  return qi === q.length
}
