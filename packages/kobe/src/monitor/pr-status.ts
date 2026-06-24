/**
 * Pure mapping for the PR-status poller (KOB-10).
 *
 * The daemon-side `pr-status-collector` shells `gh pr view <branch> --json
 * <fields>` per task and feeds the parsed JSON through {@link mapGhPrView} to
 * get a neutral {@link TaskPRStatus}. Keeping the mapping pure (no `gh`, no
 * tmux, no fs) is what lets the error-prone bits — the `statusCheckRollup`
 * reduction and the `state`→lifecycle mapping — be unit-tested directly.
 *
 * GitHub only by design (KOB-10): GitLab/Bitbucket carry no `gh` equivalent
 * here, so the collector never runs for them and this module always stamps
 * `provider: "github"`.
 */

import type { PRCheckState, PRLifecycleState, TaskPRStatus } from "@/types/task"

/** The `--json` field set the collector requests from `gh pr view`. */
export const GH_PR_VIEW_FIELDS =
  "number,url,title,state,baseRefName,headRefName,reviewDecision,mergeable,statusCheckRollup"

/**
 * One entry of `gh`'s `statusCheckRollup`. GitHub returns a heterogeneous
 * array: GraphQL `CheckRun`s carry `status` + `conclusion`; legacy
 * `StatusContext`s carry a single `state`. We read whichever is present.
 */
export interface GhCheckEntry {
  readonly __typename?: string
  /** CheckRun: QUEUED | IN_PROGRESS | COMPLETED | … */
  readonly status?: string
  /** CheckRun: SUCCESS | FAILURE | CANCELLED | TIMED_OUT | NEUTRAL | SKIPPED | … */
  readonly conclusion?: string
  /** StatusContext: SUCCESS | PENDING | FAILURE | ERROR | EXPECTED */
  readonly state?: string
}

/** Shape of `gh pr view --json <GH_PR_VIEW_FIELDS>`. All fields optional —
 * `gh` omits empties and older versions vary. */
export interface GhPrView {
  readonly number?: number
  readonly url?: string
  readonly title?: string
  readonly state?: string
  readonly baseRefName?: string
  readonly headRefName?: string
  readonly reviewDecision?: string
  readonly mergeable?: string
  readonly statusCheckRollup?: readonly GhCheckEntry[]
}

/** Map `gh`'s PR `state` (+ review decision) to a neutral lifecycle. */
export function lifecycleFromState(state: string | undefined, reviewDecision: string | undefined): PRLifecycleState {
  switch ((state ?? "").toUpperCase()) {
    case "MERGED":
      return "merged"
    case "CLOSED":
      return "closed"
    case "OPEN":
      // An approved, open PR reads as ready-to-merge; the sidebar surfaces it
      // distinctly so a finished review is obvious without opening the PR.
      return (reviewDecision ?? "").toUpperCase() === "APPROVED" ? "ready_to_merge" : "open"
    default:
      return "unknown"
  }
}

/** Reduce a check entry to one of the four headline states. */
function entryCheckState(entry: GhCheckEntry): PRCheckState {
  // CheckRun: prefer conclusion once COMPLETED, else it's still running.
  const status = (entry.status ?? "").toUpperCase()
  const conclusion = (entry.conclusion ?? "").toUpperCase()
  const contextState = (entry.state ?? "").toUpperCase()

  if (status && status !== "COMPLETED") return "pending" // QUEUED / IN_PROGRESS / WAITING / PENDING
  if (conclusion) {
    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") return "passing"
    return "failing" // FAILURE | CANCELLED | TIMED_OUT | ACTION_REQUIRED | STARTUP_FAILURE | STALE
  }
  // StatusContext path.
  if (contextState === "SUCCESS") return "passing"
  if (contextState === "PENDING" || contextState === "EXPECTED") return "pending"
  if (contextState === "FAILURE" || contextState === "ERROR") return "failing"
  return "unknown"
}

/**
 * Roll the per-check states up to the PR headline. Precedence is the same
 * mental model GitHub's own badge uses: **any** failing → failing; else any
 * pending → pending; else all-passing → passing; an empty rollup is `none`
 * (no checks configured); anything we can't read is `unknown`.
 */
export function checkStateFromRollup(rollup: readonly GhCheckEntry[] | undefined): PRCheckState {
  if (!rollup || rollup.length === 0) return "none"
  let sawPending = false
  let sawPassing = false
  for (const entry of rollup) {
    const s = entryCheckState(entry)
    if (s === "failing") return "failing"
    if (s === "pending") sawPending = true
    else if (s === "passing") sawPassing = true
  }
  if (sawPending) return "pending"
  if (sawPassing) return "passing"
  return "unknown"
}

/**
 * Map a parsed `gh pr view` payload to a {@link TaskPRStatus}. `at` is the
 * caller's ISO timestamp (kept out so the function stays pure/deterministic
 * for tests). Returns `null` when the payload has no PR number — the caller
 * treats that as "no PR for this branch" and clears any stale status.
 */
export function mapGhPrView(view: GhPrView | null | undefined, at: string): TaskPRStatus | null {
  if (!view || typeof view.number !== "number") return null
  return {
    provider: "github",
    lifecycle: lifecycleFromState(view.state, view.reviewDecision),
    checkState: checkStateFromRollup(view.statusCheckRollup),
    number: view.number,
    url: view.url,
    title: view.title,
    baseRef: view.baseRefName,
    headRef: view.headRefName,
    reviewDecision: view.reviewDecision || undefined,
    mergeable: view.mergeable || undefined,
    lastCheckedAt: at,
  }
}

/**
 * Value equality for the fields the UI renders + the poller diffs on. Excludes
 * `lastCheckedAt` (it changes every poll) and `lastError` so an unchanged PR
 * doesn't churn a persist + broadcast every tick.
 */
export function samePrStatus(a: TaskPRStatus | undefined, b: TaskPRStatus | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.provider === b.provider &&
    a.lifecycle === b.lifecycle &&
    a.checkState === b.checkState &&
    a.number === b.number &&
    a.url === b.url &&
    a.title === b.title &&
    a.baseRef === b.baseRef &&
    a.headRef === b.headRef &&
    a.reviewDecision === b.reviewDecision &&
    a.mergeable === b.mergeable
  )
}

/**
 * Whether a check-state transition is worth interrupting the user for. We
 * notify only when checks RESOLVE — pending → passing or pending → failing —
 * not on every flap (e.g. none → pending is just "CI started"). Returns the
 * landing state to notify on, or `null` for a non-event.
 */
export function checkResolutionNotify(
  prev: PRCheckState | undefined,
  next: PRCheckState,
): "passing" | "failing" | null {
  if (prev !== "pending") return null
  if (next === "passing" || next === "failing") return next
  return null
}
