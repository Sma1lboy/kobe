/**
 * Subsequence fuzzy match for the command palette's task search. Every query
 * char must appear in order in the text; the return is a RANKING score where
 * lower is better (a contiguous, earlier match scores lowest) and `null` means
 * no match. Cheap and good enough for a task list. Shared so the palette and
 * any future search surface rank identically.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let lastHit = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti - lastHit // gap penalty: contiguous runs score lowest
      lastHit = ti
      qi++
    }
  }
  return qi === q.length ? score : null
}
