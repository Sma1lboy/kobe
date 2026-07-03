/**
 * repo-key — repo-path identity for the issue-snapshot cache, shared by BOTH
 * the SPA (`src/`) and the bridge (`server/`).
 *
 * The daemon keys an `issue.snapshot` by the repo's git common-dir (its
 * main-worktree root). But a task may reference that same repo by its `repo`
 * path OR its `worktreePath`, and either can carry a trailing slash. So a
 * snapshot must be mirrored under every path that resolves to the same repo —
 * otherwise `/repo`, `/repo/`, and a worktree checkout split the UI cache and a
 * push lands under a key the board never reads.
 *
 * This was the SAME logic copy-pasted three times — `src/lib/store.ts`,
 * `server/daemon-link.ts`, and `src/lib/use-repo-issues.ts` (as a bare
 * `normalize`). A fix in one would silently diverge from the others, and only
 * the store copy carried a test. It lives here so the repo-key contract is in
 * ONE place with ONE test (`test/repo-key.test.ts`).
 *
 * Deliberately DEPENDENCY-FREE: it imports nothing and touches neither the DOM
 * nor node, so the bridge (Bun) and the SPA (browser) can both consume it
 * across the `src/`↔`server/` boundary without dragging runtime-specific code
 * either way. It takes a STRUCTURAL task shape ({@link RepoPaths}) so both the
 * SPA's `Task` and the daemon's `SerializedTask` satisfy it without a shared
 * nominal type.
 */

/** Drop a trailing slash (but keep a bare "/") so `/repo` and `/repo/` collapse
 *  to one key. */
export function normalizeRepoPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

/** The two path fields repo-key reads off a task. The SPA `Task` and the daemon
 *  `SerializedTask` both satisfy this structurally. */
export interface RepoPaths {
  readonly repo: string
  readonly worktreePath: string
}

/**
 * The repo keys a single `issue.snapshot` for `repoRoot` should be cached under:
 * the raw `repoRoot`, plus every task `repo`/`worktreePath` that normalizes to
 * the same path. The raw (un-normalized) variants are kept so a caller that
 * stores by exact path (e.g. a trailing-slash `repo`) still gets a hit.
 */
export function repoSnapshotAliases(
  tasks: readonly RepoPaths[],
  repoRoot: string,
): string[] {
  const root = normalizeRepoPath(repoRoot)
  const aliases = new Set<string>([repoRoot])
  for (const task of tasks) {
    const taskRepo = normalizeRepoPath(task.repo)
    const taskWorktree = normalizeRepoPath(task.worktreePath)
    if (taskRepo === root || taskWorktree === root) {
      if (task.repo) aliases.add(task.repo)
      if (task.worktreePath) aliases.add(task.worktreePath)
    }
  }
  return [...aliases]
}

/**
 * Sweep the issue-snapshot cache to keys still reachable from a live task's
 * `repo`/`worktreePath`. Alias keys accumulate one-per-worktree as tasks are
 * created and deleted ({@link repoSnapshotAliases} only ever adds), so both
 * mirrors — the bridge's `DaemonLink.issueSnapshots` and the SPA store — call
 * this on every authoritative `task.snapshot`, exactly like the engine-state
 * sweep beside them. A canonical (realpath'd) repoRoot key whose repo has no
 * live task is dropped too; that only costs a warm-start miss — the UI
 * re-fetches via GET. Returns the SAME object when nothing was pruned.
 */
export function pruneSnapshotAliases<T>(
  snapshots: Record<string, T>,
  tasks: readonly RepoPaths[],
): Record<string, T> {
  const live = new Set<string>()
  for (const task of tasks) {
    if (task.repo) live.add(normalizeRepoPath(task.repo))
    if (task.worktreePath) live.add(normalizeRepoPath(task.worktreePath))
  }
  const kept = Object.entries(snapshots).filter(([key]) =>
    live.has(normalizeRepoPath(key)),
  )
  return kept.length === Object.keys(snapshots).length
    ? snapshots
    : Object.fromEntries(kept)
}
