/**
 * Tiny git-HEAD helper for the sidebar's pinned "main" task rows.
 *
 * Each main task is bound to a saved repo (KOB-15) and shows the repo's
 * live current branch as a right-aligned hint — the row reads e.g.
 * `★ kobe   main`. The branch isn't stored on the task; it's computed
 * at display time so checking out a different branch in another shell
 * is reflected the next time the sidebar re-renders.
 *
 * Implementation: a synchronous `git symbolic-ref --short HEAD` call.
 * Falls back to `(detached)` if the HEAD is detached (rev-parse returns
 * the literal `HEAD`) or any other failure mode (missing repo, EACCES,
 * git not on PATH). We never throw — the sidebar must always render.
 *
 * Caching: the caller (Sidebar.tsx) wraps this in a `createMemo` keyed
 * on a polling tick + the repo path so we don't shell out on every
 * redraw frame. The polling tick advances every ~2s; this keeps the
 * branch label fresh enough for the human-scale "I just checked out
 * another branch" moment without flooding the host with git calls.
 *
 * Why a separate file rather than reaching into
 * `src/orchestrator/worktree/manager.ts#currentBranch`: that method is
 * `async` and throws on detached-HEAD. The sidebar is sync and must
 * tolerate every failure mode. Same trade-off
 * `src/tui/panes/filetree/git.ts` made — pane-side git wrappers are
 * intentionally separate from the orchestrator's stricter ones.
 */

import { spawnSync } from "node:child_process"

/**
 * Return the short branch name for `repo`'s HEAD, or a fallback string
 * for any failure. Never throws.
 *
 * Fallbacks:
 *   - Detached HEAD: `"(detached)"`.
 *   - Anything else (missing repo, permission denied, git missing,
 *     non-zero exit): `""` so the renderer skips the hint entirely
 *     rather than showing a confusing error string in the sidebar.
 */
export function readCurrentBranch(repo: string): string {
  if (!repo) return ""
  try {
    // `symbolic-ref --short HEAD` is more direct than `rev-parse
    // --abbrev-ref HEAD` for the "what branch am I on" question — it
    // exits non-zero on detached HEAD instead of returning the literal
    // string `HEAD`, so the failure mode is unambiguous.
    const out = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (out.status === 0 && out.stdout) {
      const name = out.stdout.trim()
      if (name && name !== "HEAD") return name
    }
    // Detached HEAD path: symbolic-ref exits non-zero. Confirm with
    // rev-parse so we don't mislabel an unreadable repo as detached.
    const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (head.status === 0) return "(detached)"
    return ""
  } catch {
    return ""
  }
}
