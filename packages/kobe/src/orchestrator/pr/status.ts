import { spawnSync } from "node:child_process"
import type { Task, TaskPRStatus } from "../../types/task.ts"

const GIT_TIMEOUT_MS = 5_000
const GH_TIMEOUT_MS = 8_000

type Provider = TaskPRStatus["provider"]

type GhPRView = {
  number?: unknown
  url?: unknown
  title?: unknown
  state?: unknown
  isDraft?: unknown
  mergeable?: unknown
  reviewDecision?: unknown
  statusCheckRollup?: unknown
  baseRefName?: unknown
  headRefName?: unknown
}

function run(cwd: string, command: string, args: readonly string[], timeout: number): string | null {
  try {
    const out = spawnSync(command, args.slice(), { cwd, encoding: "utf8", timeout })
    if (out.error) return null
    if (out.status !== 0) return null
    return (out.stdout ?? "").trim()
  } catch {
    return null
  }
}

export function detectPRProvider(worktreePath: string): Provider {
  const origin = run(worktreePath, "git", ["remote", "get-url", "origin"], GIT_TIMEOUT_MS)
  if (!origin) return "unknown"
  if (/(^|[:/@])github\.com[:/]/i.test(origin) || /github\.com/i.test(origin)) return "github"
  if (/gitlab\./i.test(origin) || /gitlab\.com/i.test(origin)) return "gitlab"
  if (/bitbucket\./i.test(origin) || /bitbucket\.org/i.test(origin)) return "bitbucket"
  return "unknown"
}

export function initialPRStatus(worktreePath: string): TaskPRStatus | undefined {
  const provider = detectPRProvider(worktreePath)
  if (provider !== "github") return undefined
  return {
    provider,
    lifecycle: "creating",
    checkState: "unknown",
    lastCheckedAt: new Date().toISOString(),
  }
}

export async function refreshPRStatus(task: Task): Promise<TaskPRStatus | undefined> {
  if (!task.worktreePath) return undefined
  const provider = detectPRProvider(task.worktreePath)
  if (provider !== "github") return undefined

  const json = run(
    task.worktreePath,
    "gh",
    [
      "pr",
      "view",
      "--json",
      "number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup,baseRefName,headRefName",
    ],
    GH_TIMEOUT_MS,
  )
  if (!json) {
    return {
      provider: "github",
      lifecycle: "creating",
      checkState: "unknown",
      lastCheckedAt: new Date().toISOString(),
      lastError: "No GitHub PR found for this branch yet.",
    }
  }

  let parsed: GhPRView
  try {
    parsed = JSON.parse(json) as GhPRView
  } catch {
    return {
      provider: "github",
      lifecycle: "unknown",
      checkState: "unknown",
      lastCheckedAt: new Date().toISOString(),
      lastError: "Could not parse GitHub PR status.",
    }
  }
  return normalizeGitHubPR(parsed)
}

function normalizeGitHubPR(pr: GhPRView): TaskPRStatus {
  const checkState = normalizeChecks(pr.statusCheckRollup)
  const state = typeof pr.state === "string" ? pr.state.toUpperCase() : ""
  const isDraft = pr.isDraft === true
  const mergeable = typeof pr.mergeable === "string" ? pr.mergeable : undefined
  const reviewDecision = typeof pr.reviewDecision === "string" ? pr.reviewDecision : undefined
  const lifecycle = normalizeLifecycle({ state, isDraft, mergeable, reviewDecision, checkState })
  return {
    provider: "github",
    lifecycle,
    checkState,
    ...(typeof pr.number === "number" && Number.isFinite(pr.number) ? { number: pr.number } : {}),
    ...(typeof pr.url === "string" ? { url: pr.url } : {}),
    ...(typeof pr.title === "string" ? { title: pr.title } : {}),
    ...(typeof pr.baseRefName === "string" ? { baseRef: pr.baseRefName } : {}),
    ...(typeof pr.headRefName === "string" ? { headRef: pr.headRefName } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(mergeable ? { mergeable } : {}),
    lastCheckedAt: new Date().toISOString(),
  }
}

function normalizeLifecycle(input: {
  state: string
  isDraft: boolean
  mergeable?: string
  reviewDecision?: string
  checkState: TaskPRStatus["checkState"]
}): TaskPRStatus["lifecycle"] {
  if (input.state === "MERGED") return "merged"
  if (input.state === "CLOSED") return "closed"
  if (input.state !== "OPEN") return "unknown"
  if (input.isDraft) return "open"
  if (input.reviewDecision === "CHANGES_REQUESTED") return "open"
  if (input.mergeable === "CONFLICTING") return "open"
  if (input.checkState === "failing" || input.checkState === "pending" || input.checkState === "unknown") return "open"
  return "ready_to_merge"
}

function normalizeChecks(value: unknown): TaskPRStatus["checkState"] {
  const checks = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { nodes?: unknown }).nodes)
      ? ((value as { nodes: unknown[] }).nodes ?? [])
      : []
  if (checks.length === 0) return "none"
  let sawPending = false
  let sawUnknown = false
  for (const check of checks) {
    const state = checkState(check)
    if (state === "failing") return "failing"
    if (state === "pending") sawPending = true
    if (state === "unknown") sawUnknown = true
  }
  if (sawPending) return "pending"
  if (sawUnknown) return "unknown"
  return "passing"
}

function checkState(value: unknown): TaskPRStatus["checkState"] {
  if (!value || typeof value !== "object") return "unknown"
  const v = value as Record<string, unknown>
  const conclusion = typeof v.conclusion === "string" ? v.conclusion.toUpperCase() : ""
  const status = typeof v.status === "string" ? v.status.toUpperCase() : ""
  if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(conclusion)) {
    return "failing"
  }
  if (["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion)) return "passing"
  if (["IN_PROGRESS", "QUEUED", "PENDING", "REQUESTED", "WAITING", "EXPECTED"].includes(status)) return "pending"
  if (status === "COMPLETED" && !conclusion) return "unknown"
  return "unknown"
}

export function renderPRMergeInstructions(status: TaskPRStatus): string {
  const pr = status.number ? `#${status.number}` : "the active pull request"
  const url = status.url ? `\nPR URL: ${status.url}` : ""
  return `The user clicked Merge in kobe for ${pr}.${url}

Before merging:

- Re-check the PR status with GitHub.
- Confirm CI is passing and there are no requested changes.
- If the PR is not mergeable, explain the blocker and stop.

If it is ready, merge the PR using the repository's normal GitHub workflow. Prefer \`gh pr merge\` for this branch and follow any repository-specific merge method or branch-deletion conventions.

If any step fails, ask the user for help.`
}
