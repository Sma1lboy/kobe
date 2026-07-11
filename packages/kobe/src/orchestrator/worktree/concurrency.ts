/**
 * Bounded-concurrency map — pure, no git/fs. Used by the worktree manager to
 * parallelise per-worktree git probes (dirty / last-activity) without opening
 * one ssh channel per worktree at once: 10-20 worktrees on a remote project
 * would otherwise be a serial chain (seconds) or an unbounded connection storm.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T)
    }
  }
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: width }, worker))
  return results
}

/** Concurrency cap for the per-worktree probes — keeps a remote from opening one ssh channel per worktree at once. */
export const PROBE_CONCURRENCY = 6
