/**
 * Overview keyboard navigation — moving a highlight through the triage grid's
 * flattened card order (bucket by bucket, each bucket in displayed order).
 * Unlike the rail's j/k (which switches the ACTIVE task immediately), the
 * Overview highlight is local: j/k move it, Enter opens it — so browsing the
 * grid never navigates away mid-scan. Pure + React-free for unit tests.
 */

/**
 * Next highlighted id after a j/k (or arrow) step. A fresh highlight enters
 * at the top when moving down and at the bottom when moving up; steps clamp
 * at both ends. A current id that's no longer in the order re-enters fresh.
 */
export function moveHighlight(
  order: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (order.length === 0) return null
  const cur = current ? order.indexOf(current) : -1
  if (cur === -1) return delta === 1 ? order[0] : order[order.length - 1]
  const next = Math.min(Math.max(cur + delta, 0), order.length - 1)
  return order[next]
}

/** Keep the highlight only while its card is still shown (filtering or a
 *  bucket move can drop it); identical input returns the SAME value so a
 *  reconciling setState is a no-op render-wise. */
export function reconcileHighlight(
  order: readonly string[],
  current: string | null,
): string | null {
  return current && order.includes(current) ? current : null
}
