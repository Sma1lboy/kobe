/**
 * Per-key prompt history for the chat composer.
 *
 * The in-memory layer here is a per-key (typically per chat tab) ring
 * that serves up-arrow recall. Cross-session persistence lives in
 * `./history-store.ts` (KOB-157) — at boot the TUI calls
 * {@link bootstrapHistory} to replay disk entries into the in-memory
 * STORE under a synthetic `project-${root}` key so the Ctrl+R palette
 * (KOB-154) sees them. New submissions append to disk via
 * {@link pushHistory}'s optional `project` field, fire-and-forget.
 *
 * Keying: callers pass a `historyKey` string (typically the active
 * chat tab id, occasionally a task id, or the literal `"global"`).
 * Each key gets its own ring. We use a module-level singleton because
 * the TUI mounts/unmounts the composer on every task switch — the
 * buffer must survive that without Solid context plumbing.
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
 * Up-arrow scope on reload: persisted entries are replayed under a
 * `project-${root}` key, so a fresh chat tab's up-arrow walk (keyed
 * by tab id) does NOT see them. They only surface via the Ctrl+R
 * palette, which merges every key. This is a deliberate divergence
 * from Claude Code (which feeds disk entries into up-arrow): kobe's
 * per-tab ring carries the active session's intent, mixing in
 * unrelated old prompts would clutter it.
 *
 * Tested via the behavior test (sends a prompt, presses up, asserts
 * recall) plus dedicated unit tests in
 * `test/tui/composer-history.test.ts` for the cross-key palette
 * ordering invariants.
 */

import { type DiskHistoryEntry, appendToDisk, loadFromDisk, pruneToCap } from "./history-store"

/** Max entries kept per key. 200 is roomy for a session without bloating memory. */
export const HISTORY_LIMIT = 200

/**
 * The singleton history store. Module-level so `Composer` mounts can
 * each consult/append without sharing a Solid signal. Keys never get
 * deleted — the per-key ring is bounded, the key set isn't (a session
 * with 1000 tasks creates 1000 keys; that's fine, each key holds at
 * most {@link HISTORY_LIMIT} short strings).
 *
 * Each entry carries a monotonic `seq` so cross-key consumers (the
 * Ctrl+R palette, KOB-154) can merge entries from many keys into one
 * "global newest-first" ordering without needing wall-clock timestamps
 * (which we'd need a migration story for once we ever persist).
 */
type HistoryEntry = { readonly value: string; readonly seq: number }
const STORE: Map<string, HistoryEntry[]> = new Map()
let SEQ = 0

/**
 * Count of disk appends since the last `pruneToCap` call. We prune
 * opportunistically every {@link DISK_PRUNE_INTERVAL} appends rather
 * than on every push, since the prune rewrites the whole file. With
 * the default cap (1000 entries) and a typical user pushing 50–100
 * prompts per session, this means pruning roughly every other day —
 * the file's bounded size stays bounded.
 */
const DISK_PRUNE_INTERVAL = 50
let appendsSincePrune = 0

/**
 * Disable disk persistence for tests. Vitest workers share the
 * process, so per-test `~/.kobe/composer-history.jsonl` writes would
 * leak between tests AND poison the user's real history. Tests set
 * `KOBE_HISTORY_PERSIST=false` (via env at boot or by patching this
 * function in the suite) to opt out.
 */
function isPersistEnabled(): boolean {
  return process.env.KOBE_HISTORY_PERSIST !== "false"
}

/**
 * Synthetic in-memory key under which on-disk entries are replayed at
 * boot. Per-project so the palette can later filter by current task's
 * worktree root without restructuring storage.
 */
function projectKey(project: string | undefined): string {
  return project ? `project-${project}` : "global"
}

/**
 * Sync load + replay of `<kobeStateDir()>/composer-history.jsonl`
 * into the in-memory STORE. Call once at TUI boot before the first
 * composer mounts so Ctrl+R has the prior session's prompts on
 * first paint. Entries land under per-project synthetic keys (see
 * {@link projectKey}) — up-arrow on a new tab still walks its own
 * empty ring, but the palette sees everything.
 *
 * Idempotent: calling twice replays the file twice into STORE, so
 * production code calls this exactly once. Tests should clear STORE
 * (via {@link clearAllHistory}) between runs.
 */
export function bootstrapHistory(): void {
  if (!isPersistEnabled()) return
  const entries = loadFromDisk()
  for (const e of entries) {
    const key = projectKey(e.project)
    SEQ += 1
    const ring = STORE.get(key) ?? []
    ring.push({ value: e.display, seq: SEQ })
    if (ring.length > HISTORY_LIMIT) {
      ring.splice(0, ring.length - HISTORY_LIMIT)
    }
    STORE.set(key, ring)
  }
}

/**
 * Push a new entry to the history for `key`. No-op for empty /
 * whitespace-only values, and no-op if equal to the most recent entry
 * (so repeatedly submitting the same prompt doesn't fill the ring).
 *
 * The value is stored as-is (no trim) so the user gets back exactly
 * what they typed if they re-edit a recalled entry.
 */
export function pushHistory(key: string, value: string, opts: { readonly project?: string } = {}): void {
  if (value.trim().length === 0) return
  const ring = STORE.get(key) ?? []
  const last = ring[ring.length - 1]
  if (last && last.value === value) return
  SEQ += 1
  ring.push({ value, seq: SEQ })
  if (ring.length > HISTORY_LIMIT) {
    ring.splice(0, ring.length - HISTORY_LIMIT)
  }
  STORE.set(key, ring)
  // Best-effort persistence. Fire-and-forget so the composer's submit
  // path never blocks on disk I/O; appendToDisk swallows its own
  // errors with a single console.warn. The `void` is intentional —
  // bun's `eslint-no-floating-promises` would otherwise complain.
  if (isPersistEnabled()) {
    const entry: DiskHistoryEntry = { display: value, timestamp: Date.now(), project: opts.project }
    void appendToDisk(entry)
    appendsSincePrune += 1
    if (appendsSincePrune >= DISK_PRUNE_INTERVAL) {
      appendsSincePrune = 0
      void pruneToCap()
    }
  }
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
  return ring.map((e) => e.value)
}

/**
 * Snapshot of every history entry across every key, sorted globally
 * newest-first by insertion sequence. Feeds the Ctrl+R palette
 * (KOB-154) so the user can search prompts they've sent from any task.
 *
 * Returns a fresh array — safe to index, sort, filter without
 * worrying about future {@link pushHistory} calls invalidating it.
 */
export function getAllHistoryEntries(): ReadonlyArray<{
  readonly key: string
  readonly value: string
  readonly seq: number
}> {
  const out: Array<{ key: string; value: string; seq: number }> = []
  for (const [key, ring] of STORE) {
    for (const e of ring) out.push({ key, value: e.value, seq: e.seq })
  }
  out.sort((a, b) => b.seq - a.seq)
  return out
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
 * Clear all history. Tests-only. Resets the monotonic `seq` counter
 * too so per-test ordering assertions stay deterministic.
 */
export function clearAllHistory(): void {
  STORE.clear()
  SEQ = 0
}
