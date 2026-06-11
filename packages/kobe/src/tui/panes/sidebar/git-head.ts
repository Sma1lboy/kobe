/**
 * Tiny git-HEAD poller for the sidebar's pinned "main" task rows.
 *
 * Each main task is bound to a saved repo (KOB-15) and shows the repo's
 * live current branch as a right-aligned hint — the row reads e.g.
 * `★ kobe   main`. The branch isn't stored on the task; it's computed
 * at display time so checking out a different branch in another shell
 * is reflected the next time the sidebar re-renders.
 *
 * Implementation: an ASYNC `git symbolic-ref --short HEAD` through the
 * generic `src/tui/lib/background-poll.ts` poller. The commands are O(1)
 * — they read a ref, not the working tree — but even an O(1) spawnSync
 * per project row per ~2s tick is a render-thread block (slow disk, NFS,
 * cold cache), so the render path never spawns synchronously; the memo
 * fires `pollCurrentBranch` and reads the signal. Falls back to
 * `(detached)` if the HEAD is detached (symbolic-ref exits non-zero but
 * rev-parse verifies a HEAD) or `""` for any other failure mode (missing
 * repo, EACCES, git not on PATH) so the renderer skips the hint entirely
 * rather than showing a confusing error string. Never throws — the
 * sidebar must always render.
 *
 * Why a separate file rather than reaching into
 * `src/orchestrator/worktree/manager.ts#currentBranch`: that method
 * throws on detached-HEAD. The sidebar must tolerate every failure mode.
 * Same trade-off `src/tui/panes/filetree/git.ts` made — pane-side git
 * wrappers are intentionally separate from the orchestrator's stricter
 * ones.
 */

import { stat } from "node:fs/promises"
import { join } from "node:path"
import { createBackgroundPoller, spawnCapture } from "../../lib/background-poll"

/** Kill a ref read that runs longer than this — O(1) commands, tight leash. */
export const BRANCH_POLL_TIMEOUT_MS = 2_000
/** After a timeout, leave the repo alone for this long before retrying. */
export const BRANCH_SLOW_RETRY_MS = 30_000
/** Floor between successful polls — matches the sidebar's ~2s tick. */
export const BRANCH_MIN_POLL_INTERVAL_MS = 1_500

// Uniform pane-side policy: read-only git inspection never takes
// optional locks. `symbolic-ref`/`rev-parse` don't write the index
// today, but setting this keeps every pane git call lock-free so a
// future command swap can't reintroduce `.git/index.lock` races.
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0" })

/**
 * Per-repo `.git/HEAD` fingerprint cache (waste audit). The branch NAME is
 * a pure function of HEAD's content — a checkout rewrites the file, a
 * commit on a branch does not — so when HEAD's mtime+size haven't moved
 * since the last successful resolve, the cached name is returned without
 * spawning git at all. Before this gate, every visible project row cost
 * one `git symbolic-ref` spawn per ~2s tick forever (5 projects ≈ 150
 * spawns/min steady-state, daemon-connected or not); now the steady state
 * is one ~µs `stat` per row per tick, with a spawn only on an actual HEAD
 * change. Repos where `.git/HEAD` isn't statable (a linked-worktree `.git`
 * FILE, permissions) skip the gate and keep the old always-spawn path.
 */
const headCache = new Map<string, { fingerprint: string; value: string }>()

async function headFingerprint(repo: string): Promise<string | null> {
  try {
    const st = await stat(join(repo, ".git", "HEAD"))
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

/**
 * Resolve `repo`'s current short branch name, with the HEAD-fingerprint
 * fast path above. `spawn` is injectable so tests can count subprocess
 * launches; production passes nothing and gets the real `spawnCapture`.
 * Exported for tests only — render code goes through the poller.
 */
export async function resolveBranchHead(
  repo: string,
  signal: AbortSignal,
  spawn: typeof spawnCapture = spawnCapture,
): Promise<string> {
  // Fingerprint FIRST (before the spawn): if HEAD changes mid-resolve we
  // cache the new value against the pre-change fingerprint, and the next
  // tick's mismatch simply re-resolves — the race converges.
  const fingerprint = await headFingerprint(repo)
  if (fingerprint !== null) {
    const cached = headCache.get(repo)
    if (cached && cached.fingerprint === fingerprint) return cached.value
  }
  // `symbolic-ref --short HEAD` is more direct than `rev-parse
  // --abbrev-ref HEAD` for the "what branch am I on" question — it
  // exits non-zero on detached HEAD instead of returning the literal
  // string `HEAD`, so the failure mode is unambiguous.
  let value = ""
  const ref = await spawn("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: repo,
    env: gitEnv(),
    signal,
  })
  const name = ref.status === 0 ? ref.stdout.trim() : ""
  if (name && name !== "HEAD") {
    value = name
  } else {
    // Detached HEAD path: symbolic-ref exits non-zero. Confirm with
    // rev-parse so we don't mislabel an unreadable repo as detached.
    const head = await spawn("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repo,
      env: gitEnv(),
      signal,
    })
    if (head.status === 0) value = "(detached)"
  }
  if (fingerprint !== null) headCache.set(repo, { fingerprint, value })
  return value
}

const poller = createBackgroundPoller<string>({
  initial: "",
  timeoutMs: BRANCH_POLL_TIMEOUT_MS,
  slowRetryMs: BRANCH_SLOW_RETRY_MS,
  minIntervalMs: BRANCH_MIN_POLL_INTERVAL_MS,
  run: (repo, signal) => resolveBranchHead(repo, signal),
})

/**
 * Reactive read of the last known short branch name for `repo`'s HEAD,
 * or a fallback string: `"(detached)"` for detached HEAD, `""` (hint
 * skipped) until a poll lands or for any failure. Never throws.
 */
export function currentBranch(repo: string): string {
  return poller.read(repo)
}

/**
 * Fire-and-forget: maybe start an async HEAD read for `repo`. Safe to
 * call from a reactive memo on every tick — in-flight dedupe and the
 * interval floor make the extra calls free.
 */
export function pollCurrentBranch(repo: string): void {
  poller.poll(repo)
}

/** Test hook: drop all cached entries/backoff state. */
export function resetGitHeadPoller(): void {
  poller.reset()
  headCache.clear()
}
