/**
 * Preserve row object identity across polled list rebuilds.
 *
 * Long-lived opentui panes often rebuild row arrays from fresh data. Solid's
 * `<For>` keys by object identity, so an all-new row list can churn native
 * renderables even when nothing visible changed. This helper keeps the previous
 * row object whenever the caller's key + equality policy says it is unchanged.
 */

export interface ReconcileStableRowsOptions {
  /** Reuse only when the row stayed at the same array position. */
  readonly samePosition?: boolean
}

export function reconcileStableRows<T>(
  prev: readonly T[],
  next: readonly T[],
  keyOf: (row: T) => string,
  equals: (a: T, b: T) => boolean,
  opts: ReconcileStableRowsOptions = {},
): readonly T[] {
  if (prev.length === 0) return next
  const prevByKey = new Map<string, T>()
  for (const row of prev) prevByKey.set(keyOf(row), row)
  let allReused = prev.length === next.length
  const out: T[] = new Array(next.length)
  for (let i = 0; i < next.length; i++) {
    const fresh = next[i] as T
    const old = prevByKey.get(keyOf(fresh))
    if (old && equals(old, fresh) && (!opts.samePosition || prev[i] === old)) {
      out[i] = old
      if (allReused && prev[i] !== old) allReused = false
    } else {
      out[i] = fresh
      allReused = false
    }
  }
  return allReused ? prev : out
}
