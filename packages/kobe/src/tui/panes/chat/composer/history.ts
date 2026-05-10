/**
 * Per-key prompt history for the chat composer.
 *
 * In-memory only, per-process — there is NO disk persistence yet. The
 * agent brief explicitly defers cross-session storage; recommended path
 * is `~/.kobe/composer-history.jsonl` once we surface a write path to
 * the orchestrator. Until then, history dies when kobe exits.
 *
 * Keying: callers pass a `historyKey` string (typically the active
 * task id or `"global"`). Each key gets its own ring. We use a module-
 * level singleton because the TUI mounts/unmounts the composer on
 * every task switch — the buffer must survive that without Solid
 * context plumbing.
 *
 * Ring semantics (mirrors readline / opcode / Claude Code):
 *
 *   - `push(key, value)` appends if `value` differs from the last
 *     entry. No-op on empty / whitespace-only values.
 *   - `entries(key)` returns oldest→newest.
 *   - Capped at {@link HISTORY_LIMIT} per key — we drop the oldest.
 *   - No de-duplication beyond "don't push an exact duplicate of the
 *     immediately previous entry." The user can re-issue the same
 *     prompt 5 times with a different prompt in between.
 *
 * Tested via the behavior test (sends a prompt, presses up, asserts
 * recall) — no dedicated unit test file because the surface is small
 * and the integration test pins the load-bearing invariants.
 */

/** Max entries kept per key. 200 is roomy for a session without bloating memory. */
export const HISTORY_LIMIT = 200

/**
 * The singleton history store. Module-level so `Composer` mounts can
 * each consult/append without sharing a Solid signal. Keys never get
 * deleted — the per-key ring is bounded, the key set isn't (a session
 * with 1000 tasks creates 1000 keys; that's fine, each key holds at
 * most {@link HISTORY_LIMIT} short strings).
 */
const STORE: Map<string, string[]> = new Map()

/**
 * Push a new entry to the history for `key`. No-op for empty /
 * whitespace-only values, and no-op if equal to the most recent entry
 * (so repeatedly submitting the same prompt doesn't fill the ring).
 *
 * The value is stored as-is (no trim) so the user gets back exactly
 * what they typed if they re-edit a recalled entry.
 */
export function pushHistory(key: string, value: string): void {
  if (value.trim().length === 0) return
  const ring = STORE.get(key) ?? []
  const last = ring[ring.length - 1]
  if (last === value) return
  ring.push(value)
  if (ring.length > HISTORY_LIMIT) {
    ring.splice(0, ring.length - HISTORY_LIMIT)
  }
  STORE.set(key, ring)
}

/**
 * Read-only view of the history for `key`. Returns a fresh array (not
 * a reference into the store) so callers can index without worrying
 * about future appends invalidating their indices.
 *
 * Order: oldest first, newest last. UI navigation typically walks from
 * the end backwards (up arrow → previous), so callers index from
 * `entries.length - 1` down.
 */
export function getHistory(key: string): readonly string[] {
  const ring = STORE.get(key)
  if (!ring) return []
  return ring.slice()
}

/**
 * Clear history for a specific key. Used by tests to start clean
 * without poisoning subsequent runs in the same process. NOT exposed
 * as a UI gesture.
 */
export function clearHistory(key: string): void {
  STORE.delete(key)
}

/**
 * Clear all history. Tests-only.
 */
export function clearAllHistory(): void {
  STORE.clear()
}
