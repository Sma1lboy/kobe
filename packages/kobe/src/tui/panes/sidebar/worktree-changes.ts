/**
 * Tiny worktree-changes helper for the sidebar's per-row `+N −M` chip.
 *
 * Each task row renders a status badge + title; this helper feeds the
 * right-edge "uncommitted file counts" chip:
 *
 *   `+N` — files added, modified, renamed, copied, or untracked
 *   `−M` — files deleted (in index or worktree)
 *
 * Shows up next to the task title only when the worktree is dirty —
 * a clean tracked branch contributes nothing, so the row reads as it
 * always has.
 *
 * Implementation: a single synchronous `git status --porcelain=v1`
 * call, classified per row (any `D` in either column → `−`, anything
 * else → `+`). Falls back to all-zeros for any failure mode (missing
 * repo, EACCES, git not on PATH, worktree gone) so the chip is hidden
 * rather than showing a confusing error state. Never throws — the
 * sidebar must always render.
 *
 * ⚠️ SYNC — one-shot CLI use ONLY (`kobe api` task queries). `git
 * status` is O(repo size); calling this from a render path froze the
 * Tasks pane for the lifetime of a 30GB repo's status walk, every
 * tick. The sidebar reads through `worktree-changes-poller.ts` (async
 * spawn + in-flight dedupe + timeout/backoff) instead — new render-
 * path consumers must too. Only `parsePorcelain` is shared.
 *
 * Why a separate file rather than reaching into
 * `src/orchestrator/worktree/manager.ts#isDirty`: that one is `async`,
 * boolean-only, and throws. The sidebar is sync, needs counts, and
 * tolerates every failure mode. Same trade-off `git-head.ts` and
 * `src/tui/panes/filetree/git.ts` made — pane-side git wrappers are
 * intentionally separate from the orchestrator's stricter ones.
 */

import { spawnSync } from "node:child_process"
import { readOnlyGitProcessEnv } from "@/lib/git-env"
import { parsePorcelainRows } from "@/lib/git-parsers"

export interface WorktreeChanges {
  /** Files added, modified, renamed, copied, or untracked. */
  readonly added: number
  /** Files deleted (in index or worktree). */
  readonly deleted: number
}

const ZERO: WorktreeChanges = { added: 0, deleted: 0 }

/**
 * Value equality for change counts — shared by the local poller's signal
 * `equals`, the sidebar's per-row memo, and the RemoteOrchestrator's
 * pushed-map comparison, so "unchanged counts don't re-render rows"
 * (DESIGN §5.5) is one predicate everywhere.
 */
export function sameWorktreeChanges(a: WorktreeChanges, b: WorktreeChanges): boolean {
  return a.added === b.added && a.deleted === b.deleted
}

/**
 * Pick the DAEMON-pushed counts for a row, or `null` when the local
 * poller must serve it (issue #6). A non-null `pushed` map means a
 * daemon-side collector owns git polling for this process — a worktree
 * absent from the map (just-created task, archived row, remote project)
 * reads as zeros (chip hidden), NEVER as "poll locally": the fallback is
 * per-connection, not per-row, or every pane would re-grow git polls for
 * exactly the rows the daemon deliberately skips. Pure — unit-tested.
 */
export function pickPushedChanges(
  pushed: ReadonlyMap<string, WorktreeChanges> | null | undefined,
  worktreePath: string,
): WorktreeChanges | null {
  if (!pushed) return null
  return pushed.get(worktreePath) ?? ZERO
}

/**
 * Read worktree change counts for `worktreePath`. Never throws —
 * returns zeros for any failure mode so the renderer skips the chip.
 */
export function readWorktreeChanges(worktreePath: string): WorktreeChanges {
  if (!worktreePath) return ZERO
  try {
    const out = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // `git status` opportunistically rewrites `.git/index` (refreshed
      // stat cache), which takes `.git/index.lock`. This runs on a 2s
      // poll for every row, so it would race the worktree's engine
      // commits and other panes for the lock. `GIT_OPTIONAL_LOCKS=0`
      // makes this read-only: inspect, don't write, never take the lock.
      env: readOnlyGitProcessEnv(),
    })
    if (out.status !== 0 || !out.stdout) return ZERO
    return parsePorcelain(out.stdout)
  } catch {
    return ZERO
  }
}

/**
 * Aggregate porcelain output into `+N −M` counts. Exported for unit tests.
 *
 * Parsing (the `XY <path>` shape, branch-header skip, C-string unquoting,
 * rename resolution) is delegated to the shared {@link parsePorcelainRows};
 * this helper only classifies each row by its raw status pair: a `D` in
 * EITHER column counts as a deletion, everything else (M, A, R, C, T, U, ??)
 * as an addition. A rename is one porcelain row → one `added` event, as
 * before — the shared parser preserves the raw `x`/`y` chars so this
 * classification is byte-for-byte the same as the old inline scan.
 */
export function parsePorcelain(text: string): WorktreeChanges {
  let added = 0
  let deleted = 0
  for (const { x, y } of parsePorcelainRows(text)) {
    if (x === "D" || y === "D") deleted += 1
    else added += 1
  }
  return { added, deleted }
}
