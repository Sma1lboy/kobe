/**
 * Worktree staleness rubric — the pure judgment core behind the
 * worktree-management page's verdict badges (`worktree.list` handler
 * collects the signals; this module only ranks them).
 *
 * Signal cascade, strongest first — each weaker signal is a FALLBACK for
 * when the stronger ones are unavailable (no GitHub remote, `gh` missing
 * or unauthenticated, offline):
 *
 *   1. dirty working tree        → active  (uncommitted work, never stale)
 *   2. open PR on the branch     → active  (in review)
 *   3. PR merged                 → merged  (safe to clean — the ONLY
 *                                  signal that survives kobe's default
 *                                  squash-merge, which never makes branch
 *                                  commits ancestors of main)
 *   4. 0 commits ahead of the    → merged  (history-level: everything the
 *      default branch                        branch has is already in main;
 *                                            also covers a never-committed
 *                                            worktree — equally cleanable)
 *   5. PR closed without merging → stale   (abandoned)
 *   6. no activity for 14 days   → stale   (age fallback)
 *   7. otherwise                 → fresh
 */

export type WorktreeVerdict = "active" | "merged" | "stale" | "fresh"

/** i18n suffix under `worktrees.verdict.*` naming WHY the verdict fired. */
export type WorktreeVerdictReason = "dirty" | "prOpen" | "prMerged" | "inMain" | "prClosed" | "idle" | "fresh"

export type PrState = "open" | "merged" | "closed"

export interface WorktreeStaleSignals {
  readonly dirty: boolean
  /** Branch's PR state on the forge; null = unknown (non-GitHub, no `gh`, timeout). */
  readonly prState: PrState | null
  /** `git rev-list --count <origin-default>..HEAD`; null = no default branch resolvable. */
  readonly aheadOfDefault: number | null
  /** Last commit time (fallback: dir mtime), epoch ms; 0 = unknown. */
  readonly lastActivityMs: number
}

export const STALE_AGE_DAYS = 14

export interface WorktreeJudgement {
  readonly verdict: WorktreeVerdict
  readonly reason: WorktreeVerdictReason
}

export function judgeWorktree(signals: WorktreeStaleSignals, nowMs: number): WorktreeJudgement {
  if (signals.dirty) return { verdict: "active", reason: "dirty" }
  if (signals.prState === "open") return { verdict: "active", reason: "prOpen" }
  if (signals.prState === "merged") return { verdict: "merged", reason: "prMerged" }
  if (signals.aheadOfDefault === 0) return { verdict: "merged", reason: "inMain" }
  if (signals.prState === "closed") return { verdict: "stale", reason: "prClosed" }
  if (signals.lastActivityMs > 0 && nowMs - signals.lastActivityMs > STALE_AGE_DAYS * 24 * 60 * 60 * 1000) {
    return { verdict: "stale", reason: "idle" }
  }
  return { verdict: "fresh", reason: "fresh" }
}

/**
 * Parse `gh pr list --state all --json headRefName,state` output into a
 * branch → PR-state map. A branch can have several PRs (an old closed one
 * plus a fresh open one) — the strongest wins: open > merged > closed.
 * Returns null on malformed output (treated as "no PR data").
 */
export function parseGhPrList(stdout: string): ReadonlyMap<string, PrState> | null {
  let entries: unknown
  try {
    entries = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  const rank: Record<PrState, number> = { open: 3, merged: 2, closed: 1 }
  const map = new Map<string, PrState>()
  for (const entry of entries) {
    const branch = (entry as { headRefName?: unknown })?.headRefName
    const rawState = (entry as { state?: unknown })?.state
    if (typeof branch !== "string" || typeof rawState !== "string") continue
    const state = rawState.toLowerCase()
    if (state !== "open" && state !== "merged" && state !== "closed") continue
    const cur = map.get(branch)
    if (!cur || rank[state] > rank[cur]) map.set(branch, state)
  }
  return map
}
