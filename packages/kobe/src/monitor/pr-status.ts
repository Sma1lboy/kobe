import { applyJitter, exponentialBackoff } from "@/lib/poll-scheduling"
import type { PRCheckState, PRLifecycleState, TaskPRStatus } from "@/types/task"

export const GH_PR_VIEW_FIELDS =
  "number,url,title,state,baseRefName,headRefName,reviewDecision,mergeable,statusCheckRollup"

export interface GhCheckEntry {
  readonly __typename?: string
  readonly status?: string
  readonly conclusion?: string
  readonly state?: string
}

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

export function lifecycleFromState(state: string | undefined, reviewDecision: string | undefined): PRLifecycleState {
  switch ((state ?? "").toUpperCase()) {
    case "MERGED":
      return "merged"
    case "CLOSED":
      return "closed"
    case "OPEN":
      return (reviewDecision ?? "").toUpperCase() === "APPROVED" ? "ready_to_merge" : "open"
    default:
      return "unknown"
  }
}

function entryCheckState(entry: GhCheckEntry): PRCheckState {
  const status = (entry.status ?? "").toUpperCase()
  const conclusion = (entry.conclusion ?? "").toUpperCase()
  const contextState = (entry.state ?? "").toUpperCase()

  if (status && status !== "COMPLETED") return "pending"
  if (conclusion) {
    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") return "passing"
    return "failing"
  }
  if (contextState === "SUCCESS") return "passing"
  if (contextState === "PENDING" || contextState === "EXPECTED") return "pending"
  if (contextState === "FAILURE" || contextState === "ERROR") return "failing"
  return "unknown"
}

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

export type PrViewErrorKind = "missing-binary" | "auth" | "timeout" | "network" | "parse" | "no-remote"

export interface GhFailureSignals {
  readonly spawnError?: boolean
  readonly timedOut?: boolean
  readonly exitCode?: number | null
  readonly stderr?: string
  readonly parseError?: boolean
}

const NO_REMOTE_PATTERNS = [
  "none of the git remotes",
  "no git remote",
  "to use github cli in a github repository",
  "not a github repository",
]
const AUTH_PATTERNS = [
  "gh auth login",
  "authentication required",
  "not logged in",
  "http 401",
  "bad credentials",
  "requires authentication",
]
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
const NO_PR_PATTERNS = ["no pull requests found", "no open pull requests", "no pull request found"]

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n))
}

export function classifyGhFailure(s: GhFailureSignals): { kind: "empty" } | { kind: "error"; error: PrViewErrorKind } {
  if (s.parseError) return { kind: "error", error: "parse" }
  if (s.timedOut) return { kind: "error", error: "timeout" }
  if (s.spawnError) return { kind: "error", error: "missing-binary" }
  const err = (s.stderr ?? "").toLowerCase()
  if (matchesAny(err, NO_PR_PATTERNS)) return { kind: "empty" }
  if (matchesAny(err, NO_REMOTE_PATTERNS)) return { kind: "error", error: "no-remote" }
  if (matchesAny(err, AUTH_PATTERNS)) return { kind: "error", error: "auth" }
  if (matchesAny(err, NETWORK_PATTERNS)) return { kind: "error", error: "network" }
  return { kind: "empty" }
}

export interface PrBackoffConfig {
  readonly tickMs: number
  readonly settledMs: number
  readonly noPrMs: number
  readonly noRemoteMs: number
  readonly failureBaseMs: number
  readonly failureCapMs: number
  readonly jitterRatio: number
}

export type PrPollOutcome =
  | { kind: "pr"; settled: boolean }
  | { kind: "empty" }
  | { kind: "error"; error: PrViewErrorKind }

export interface PrPollDecision {
  readonly nextAllowedAt: number
  readonly failures: number
}

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

export function checkResolutionNotify(
  prev: PRCheckState | undefined,
  next: PRCheckState,
): "passing" | "failing" | null {
  if (prev !== "pending") return null
  if (next === "passing" || next === "failing") return next
  return null
}
