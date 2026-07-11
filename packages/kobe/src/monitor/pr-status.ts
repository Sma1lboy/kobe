/**
 * Pure mapping for the PR-status poller.
 *
 * The daemon-side `pr-status-collector` shells `gh pr view <branch> --json
 * <fields>` per task and feeds the parsed JSON through {@link mapGhPrView} to
 * get a neutral {@link TaskPRStatus}. Keeping the mapping pure (no `gh`, no
 * tmux, no fs) is what lets the error-prone bits — the `statusCheckRollup`
 * reduction and the `state`→lifecycle mapping — be unit-tested directly.
 *
 * GitHub only by design: GitLab/Bitbucket carry no `gh` equivalent
 * here, so the collector never runs for them and this module always stamps
 * `provider: "github"`.
 */

import { applyJitter, exponentialBackoff } from "@/lib/poll-scheduling"
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

// ---------------------------------------------------------------------------
// Failure classification + adaptive backoff (the "gh broke" vs "no PR" split).
//
// The poller used to collapse every non-success `gh pr view` — gh missing,
// unauthed, a network stall, a rate-limit, malformed JSON, no GitHub remote —
// into the same "no PR" result, so a broken `gh` was indistinguishable from a
// branch that simply has no PR yet and the user got no signal. These pure
// helpers split a failure into a genuine `empty` (gh ran, said no PR) vs a
// typed transport/tooling `error`, and compute the next poll delay so a
// persistent failure backs off (and a deterministic "no GitHub remote" settles
// to a long idle cadence) instead of re-spawning `gh` at full rate.
// ---------------------------------------------------------------------------

/**
 * The diagnosable kinds of `gh pr list` failure. Distinct from a genuine "no
 * PR for this branch" (that's a structural empty-array SUCCESS, never a
 * failure kind — see the `pr-status-collector.ts` file header), so the daemon
 * can log *why* PR status is unavailable and back off appropriately:
 *   - `missing-binary` — `gh` is not on PATH (deterministic-ish; backoff caps it).
 *   - `auth`           — not logged in / bad credentials (`gh auth login`).
 *   - `timeout`        — our own abort fired (the network stalled).
 *   - `network`        — DNS / connection / TLS / rate-limit failure.
 *   - `parse`          — exit 0 but the JSON didn't parse.
 *   - `no-remote`      — the worktree has no GitHub remote at all. DETERMINISTIC:
 *                        this repo will never sprout a GitHub PR, so it settles
 *                        to a long idle cadence rather than retrying with backoff.
 *   - `unknown`        — a non-zero exit that matched none of the above
 *                        patterns (gh's error text changed, a proxy, a
 *                        non-English locale, …). Still a real error — it backs
 *                        off like any other, it just can't be labeled further.
 */
export type PrViewErrorKind = "missing-binary" | "auth" | "timeout" | "network" | "parse" | "no-remote" | "unknown"

/** The raw signals from one non-success `gh pr list` run, fed to {@link classifyGhFailure}. */
export interface GhFailureSignals {
  /** The child failed to spawn (e.g. ENOENT) — and it was NOT our abort. */
  readonly spawnError?: boolean
  /** Our timeout aborted the run. */
  readonly timedOut?: boolean
  /** Exit code when the process actually ran (null on spawn error / abort). */
  readonly exitCode?: number | null
  /** Captured stderr (matched case-insensitively). */
  readonly stderr?: string
  /** `JSON.parse` threw on a zero-exit stdout. */
  readonly parseError?: boolean
}

/** stderr fragments (lowercase) that mean "this repo has no GitHub remote". */
const NO_REMOTE_PATTERNS = [
  "none of the git remotes",
  "no git remote",
  "to use github cli in a github repository",
  "not a github repository",
]
/** stderr fragments that mean "gh is not authenticated". */
const AUTH_PATTERNS = [
  "gh auth login",
  "authentication required",
  "not logged in",
  "http 401",
  "bad credentials",
  "requires authentication",
]
/** stderr fragments that mean a transient network / transport problem. */
const NETWORK_PATTERNS = [
  "could not resolve host",
  "no such host",
  "dial tcp",
  "connection refused",
  "connection reset",
  "network is unreachable",
  "i/o timeout",
  "timeout",
  "tls handshake",
  "http 5",
  "rate limit",
  "try again",
]
function matchesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n))
}

/**
 * Classify a non-success `gh pr list` run into a typed transport/tooling
 * `error`. Pure + unit-tested. There is no `empty` outcome here anymore: "no
 * PR for this branch" is a structural SUCCESS (`gh pr list` exits 0 with an
 * empty JSON array — see `pr-status-collector.ts`), never inferred from a
 * failure's stderr. So every non-zero exit is a genuine error; an
 * unrecognized one still classifies as `error` (kind `"unknown"`) rather than
 * silently collapsing to "no PR" — a broken `gh` must never look like a clean
 * "no PR yet" to the poller.
 */
export function classifyGhFailure(s: GhFailureSignals): { kind: "error"; error: PrViewErrorKind } {
  if (s.parseError) return { kind: "error", error: "parse" }
  if (s.timedOut) return { kind: "error", error: "timeout" }
  if (s.spawnError) return { kind: "error", error: "missing-binary" }
  const err = (s.stderr ?? "").toLowerCase()
  if (matchesAny(err, NO_REMOTE_PATTERNS)) return { kind: "error", error: "no-remote" }
  if (matchesAny(err, AUTH_PATTERNS)) return { kind: "error", error: "auth" }
  if (matchesAny(err, NETWORK_PATTERNS)) return { kind: "error", error: "network" }
  return { kind: "error", error: "unknown" }
}

/** Cadence knobs for {@link nextPrPoll}. All ms; clock domain is the caller's. */
export interface PrBackoffConfig {
  /** Normal re-scan cadence for an open PR (checks move). */
  readonly tickMs: number
  /** A merged/closed PR is done — poll it rarely. */
  readonly settledMs: number
  /** A branch with a genuine "no PR yet". */
  readonly noPrMs: number
  /** Deterministic "no GitHub remote" — long idle cadence, no retry storm. */
  readonly noRemoteMs: number
  /** First transient-failure backoff (typically the tick cadence). */
  readonly failureBaseMs: number
  /** Upper bound on exponential failure backoff. */
  readonly failureCapMs: number
  /** ± jitter ratio applied to every scheduled delay (0..1). */
  readonly jitterRatio: number
}

/** What one poll produced — drives the next delay + failure-streak bookkeeping. */
export type PrPollOutcome =
  | { kind: "pr"; settled: boolean }
  | { kind: "empty" }
  | { kind: "error"; error: PrViewErrorKind }

/** Per-task scheduling state carried across passes. */
export interface PrPollDecision {
  /** Earliest the task may be polled again (caller's `now` + jittered delay). */
  readonly nextAllowedAt: number
  /** Consecutive transient failures — 0 after any success/empty/no-remote. */
  readonly failures: number
}

/**
 * Decide when a task may next be polled, given the latest outcome and its prior
 * consecutive-failure streak. Pure + deterministic (inject `rand` for tests):
 *   - success / genuine empty → reset the streak, jittered base cadence.
 *   - `no-remote` (deterministic) → reset the streak, settle to the long idle
 *     cadence (it will never have a GitHub PR — don't retry with backoff).
 *   - any other error → grow the streak, exponential-backoff capped at
 *     `failureCapMs`, so a persistent failure (gh missing/unauthed) stops
 *     re-spawning at full rate.
 * Jitter is applied to every delay so N tasks coming due together (e.g. after a
 * network reconnect) don't poll in lockstep.
 */
export function nextPrPoll(
  outcome: PrPollOutcome,
  prevFailures: number,
  now: number,
  cfg: PrBackoffConfig,
  rand: () => number = Math.random,
): PrPollDecision {
  const at = (delay: number): number => now + applyJitter(delay, cfg.jitterRatio, rand)
  if (outcome.kind === "pr") {
    return { nextAllowedAt: at(outcome.settled ? cfg.settledMs : cfg.tickMs), failures: 0 }
  }
  if (outcome.kind === "empty") {
    return { nextAllowedAt: at(cfg.noPrMs), failures: 0 }
  }
  if (outcome.error === "no-remote") {
    return { nextAllowedAt: at(cfg.noRemoteMs), failures: 0 }
  }
  const failures = prevFailures + 1
  return { nextAllowedAt: at(exponentialBackoff(cfg.failureBaseMs, failures - 1, cfg.failureCapMs)), failures }
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
