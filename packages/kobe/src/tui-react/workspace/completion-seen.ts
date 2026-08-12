/**
 * Durable "I already looked at this completion" record — the persisted half
 * of the sidebar's unread lamp (● turn done, not yet viewed).
 *
 * The lamp's seen bit used to live ONLY in a process-local Set, so quitting
 * kobe threw the fact away while the daemon kept publishing the very same
 * `turn_complete` (its activity registry is daemon-lived, not TUI-lived).
 * Every completion you had already read came back unread on the next launch
 * — owner report 2026-08-12, issue #22.
 *
 * The mark is the completion's own timestamp: `turn_complete` is a STICKY
 * activity state, so its `at` is stamped once by the reporting event and
 * only a new event restamps it. Recording "seen up to `at`" per (task, tab)
 * therefore reads exactly right across restarts — an older completion is
 * read, a newer one is not — with no way for a stale entry to swallow a
 * fresh turn.
 *
 * Framework-free so the row cards, the tree's tab rows and unit tests share
 * one rule; the KV layer just persists the record.
 */

export const COMPLETION_SEEN_KEY = "completionSeen"

/** Bounded like the visit log — the oldest marks are pruned, and a pruned
 *  mark can at worst re-light one lamp for a task untouched that long. */
const SEEN_LIMIT = 200

export type CompletionSeenKv = {
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
}

/** Row identity of a seen mark: a task's own rollup, or one of its tabs.
 *  Same NUL-joined shape the session Set has always used. */
export function completionSeenKey(taskId: string, tabId?: string): string {
  return tabId === undefined ? taskId : `${taskId}\0${tabId}`
}

/** Persisted marks are user-editable JSON — drop anything malformed. */
export function parseCompletionSeen(stored: unknown): Record<string, number> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {}
  const out: Record<string, number> = {}
  for (const [key, at] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) out[key] = at
  }
  return out
}

/**
 * Fold one seen completion into the record, pruning the oldest marks at the
 * cap. Returns the INPUT object when the record already covers `at`, so the
 * caller can skip the write (this runs per viewed row, per render).
 */
export function foldCompletionSeen(
  seen: Readonly<Record<string, number>>,
  key: string,
  at: number,
  limit = SEEN_LIMIT,
): Readonly<Record<string, number>> {
  const known = seen[key]
  if (known !== undefined && known >= at) return seen
  const next: Record<string, number> = { ...seen, [key]: at }
  const keys = Object.keys(next)
  if (keys.length <= limit) return next
  const pruned: Record<string, number> = {}
  for (const k of keys.sort((a, b) => next[b] - next[a]).slice(0, limit)) pruned[k] = next[k]
  return pruned
}

/**
 * Has this row's CURRENT completion already been looked at? `at` is the
 * activity entry's stamp; `undefined` means the row isn't sitting on a
 * completion at all, which is never "seen".
 */
export function completionSeenAt(kv: CompletionSeenKv | null, key: string, at: number | undefined): boolean {
  if (!kv || at === undefined) return false
  // Read the raw snapshot rather than parsing the whole record: this is a
  // render-path call, once per row per frame.
  const stored = kv.get(COMPLETION_SEEN_KEY)
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return false
  const known = (stored as Record<string, unknown>)[key]
  return typeof known === "number" && known >= at
}

/** Record that the user has seen this completion. No-op when already covered. */
export function markCompletionSeen(kv: CompletionSeenKv, key: string, at: number): void {
  const seen = parseCompletionSeen(kv.get(COMPLETION_SEEN_KEY))
  const next = foldCompletionSeen(seen, key, at)
  if (next !== seen) kv.set(COMPLETION_SEEN_KEY, next)
}
