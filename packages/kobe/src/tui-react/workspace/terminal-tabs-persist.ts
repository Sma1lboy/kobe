/**
 * Persisted terminal-tab snapshot reclamation (O19) — the `terminalTabs.*` kv
 * keys `TerminalTabs.tsx` writes on every tab mutation (the whole splitTree +
 * pinned sessionId per task) were WRITE-ONLY: nothing ever deleted them, so a
 * high-churn build/delete workflow (fan-out is the product's basic move) grew
 * one orphan snapshot per deleted task forever, and because kv-core reads and
 * rewrites the whole file, every leftover key taxed every later tab write.
 * The web side already does the symmetric cleanup (kobe-web tabs.ts), so this
 * is a TUI-side gap, not a design choice.
 *
 * Two pure operations over a minimal kv surface (`set(key, undefined)` deletes
 * — kv-core's explicit-undefined serialization). Framework-free so both live
 * under vitest with a fake kv.
 *
 * IMPORTANT — hook on DELETE, never on the archived-task sweep: archiving must
 * KEEP the snapshot so unarchive can `--resume` the same session. Deleting a
 * task destroys its worktree/branch/history, so its tab snapshot is genuinely
 * dead and safe to reclaim.
 */

const TERMINAL_TABS_PREFIX = "terminalTabs."

/** The kv key holding one task's persisted tab snapshot. */
export function terminalTabsKey(taskId: string): string {
  return `${TERMINAL_TABS_PREFIX}${taskId}`
}

/** The minimal kv surface these helpers need (satisfied by `KVContext`). */
export interface TabsSnapshotKv {
  readonly store: Record<string, unknown>
  set(key: string, value: unknown): void
}

/** Reclaim one deleted task's persisted tab snapshot (explicit-undefined = delete). */
export function forgetTaskTabsSnapshot(kv: TabsSnapshotKv, taskId: string): void {
  const key = terminalTabsKey(taskId)
  if (kv.store[key] === undefined) return
  kv.set(key, undefined)
}

/**
 * One-time orphan sweep: drop every `terminalTabs.*` snapshot whose task id is
 * not in `liveTaskIds` — clears the historical backlog that accumulated before
 * delete-time reclamation existed. `liveTaskIds` MUST include archived tasks
 * (their snapshots are load-bearing for unarchive --resume). Returns the count
 * swept, for a caller log. Idempotent: a second call sweeps nothing.
 */
export function sweepOrphanTabsSnapshots(kv: TabsSnapshotKv, liveTaskIds: Iterable<string>): number {
  const live = new Set(liveTaskIds)
  let swept = 0
  for (const key of Object.keys(kv.store)) {
    if (!key.startsWith(TERMINAL_TABS_PREFIX)) continue
    const taskId = key.slice(TERMINAL_TABS_PREFIX.length)
    if (live.has(taskId)) continue
    kv.set(key, undefined)
    swept++
  }
  return swept
}
