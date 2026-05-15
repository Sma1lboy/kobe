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
 * Caching: the caller (Sidebar.tsx) wraps this in a `createMemo` keyed
 * on the existing `branchTick` + the worktree path so we don't shell
 * out on every redraw frame. Tick advances every ~2s — same cadence
 * as the main-row branch refresh.
 *
 * Why a separate file rather than reaching into
 * `src/orchestrator/worktree/manager.ts#isDirty`: that one is `async`,
 * boolean-only, and throws. The sidebar is sync, needs counts, and
 * tolerates every failure mode. Same trade-off `git-head.ts` and
 * `src/tui/panes/filetree/git.ts` made — pane-side git wrappers are
 * intentionally separate from the orchestrator's stricter ones.
 */

import { spawnSync } from "node:child_process"

export interface WorktreeChanges {
  /** Files added, modified, renamed, copied, or untracked. */
  readonly added: number
  /** Files deleted (in index or worktree). */
  readonly deleted: number
}

const ZERO: WorktreeChanges = { added: 0, deleted: 0 }

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
    })
    if (out.status !== 0 || !out.stdout) return ZERO
    return parsePorcelain(out.stdout)
  } catch {
    return ZERO
  }
}

/** Exported for unit tests. */
export function parsePorcelain(text: string): WorktreeChanges {
  let added = 0
  let deleted = 0
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("##")) continue
    // Porcelain v1 entries are `XY <path>` where X is the index status
    // and Y is the worktree status. `??` is untracked. We classify a
    // row as `deleted` if either column is `D`; everything else (M, A,
    // R, C, T, U, ??) counts as `added`. Renames appear on a single
    // line — still one file event, so a single count.
    const x = line.charAt(0)
    const y = line.charAt(1)
    if (x === "D" || y === "D") deleted += 1
    else added += 1
  }
  return { added, deleted }
}
