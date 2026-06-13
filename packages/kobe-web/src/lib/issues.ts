/**
 * Issues API client + pure helpers — talks to the bridge's /api/issues
 * routes (packages/kobe/src/web/issues.ts), which read/write each repo's
 * committed `docs/issues.json`. Also owns quick-start: spawning a kobe
 * task from an issue via the existing task-creation + PTY plumbing.
 */

import { fetchDefaultEngine } from "./settings.ts"
import { rpc } from "./store.ts"
import { ensureEngineTab } from "./tabs.ts"
import { sendPtyText } from "./terminal.ts"

export type IssueStatus = "open" | "doing" | "hold" | "done"

export interface Issue {
  id: number
  title: string
  status: IssueStatus
  created: string
  body: string
}

export interface RepoIssues {
  repoRoot: string
  exists: boolean
  nextId: number
  issues: Issue[]
}

/* ----- fetch helpers ------------------------------------------------------ */

async function failWith(res: Response, what: string): Promise<never> {
  const detail = await res.text().catch(() => "")
  throw new Error(
    `failed to ${what} (${res.status})${detail ? `: ${detail}` : ""}`,
  )
}

/** Load a repo's issues. A missing file is NOT an error: `exists: false`. */
export async function fetchIssues(repoRoot: string): Promise<RepoIssues> {
  const res = await fetch(
    `/api/issues?repoRoot=${encodeURIComponent(repoRoot)}`,
  )
  if (!res.ok) await failWith(res, "load issues")
  return (await res.json()) as RepoIssues
}

async function postOp(repoRoot: string, op: unknown): Promise<RepoIssues> {
  const res = await fetch("/api/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot, op }),
  })
  if (!res.ok) await failWith(res, "update issues")
  return (await res.json()) as RepoIssues
}

/** Create an issue (id allocated server-side from nextId, status `open`). */
export async function createIssue(
  repoRoot: string,
  input: { title: string; body?: string },
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "create", ...input })
}

export async function setIssueStatus(
  repoRoot: string,
  id: number,
  status: IssueStatus,
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "setStatus", id, status })
}

export async function updateIssue(
  repoRoot: string,
  id: number,
  patch: { title?: string; body?: string },
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "update", id, ...patch })
}

async function syncIssuesToWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  const res = await fetch("/api/issues/sync-worktree", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot, worktreePath }),
  })
  if (!res.ok) await failWith(res, "sync issues into worktree")
}

/* ----- pure helpers ------------------------------------------------------- */

/** Column order for the project view. */
export const ISSUE_STATUSES: readonly IssueStatus[] = [
  "open",
  "doing",
  "hold",
  "done",
]

/** Status display grammar — title + accent per column, Board-style. */
export const STATUS_META: Record<
  IssueStatus,
  { title: string; accent: string }
> = {
  open: { title: "Open", accent: "text-kobe-blue" },
  doing: { title: "Doing", accent: "text-kobe-orange" },
  hold: { title: "Hold", accent: "text-kobe-yellow" },
  done: { title: "Done", accent: "text-kobe-green" },
}

/** The legal one-click moves from a status, with their action labels. */
export function statusActions(
  status: IssueStatus,
): Array<{ label: string; to: IssueStatus }> {
  switch (status) {
    case "open":
      return [
        { label: "Start", to: "doing" },
        { label: "Hold", to: "hold" },
        { label: "Done", to: "done" },
      ]
    case "doing":
      return [
        { label: "Hold", to: "hold" },
        { label: "Done", to: "done" },
      ]
    case "hold":
      return [
        { label: "Resume", to: "open" },
        { label: "Done", to: "done" },
      ]
    case "done":
      return [{ label: "Reopen", to: "open" }]
  }
}

/** Quick start spawns a task to work the issue — done issues have nothing
 *  left to start. */
export function canQuickStart(status: IssueStatus): boolean {
  return status !== "done"
}

/**
 * Search + status filter. The query matches title and body
 * case-insensitively, plus the `#<id>` reference (so typing "#12" finds
 * issue 12). An empty/undefined statuses list means "all statuses".
 */
export function filterIssues(
  issues: readonly Issue[],
  q: { query?: string; statuses?: readonly IssueStatus[] },
): Issue[] {
  const query = (q.query ?? "").trim().toLowerCase()
  const statuses = q.statuses && q.statuses.length > 0 ? q.statuses : null
  return issues.filter((issue) => {
    if (statuses && !statuses.includes(issue.status)) return false
    if (!query) return true
    const haystack = `#${issue.id} ${issue.title} ${issue.body}`.toLowerCase()
    return haystack.includes(query)
  })
}

/**
 * Bucket issues into the four status columns. Active columns
 * (open/doing/hold) read newest-created first (then id desc as the
 * tiebreak — `created` is day-granular); done is plain id desc.
 */
export function groupByStatus(
  issues: readonly Issue[],
): Record<IssueStatus, Issue[]> {
  const groups: Record<IssueStatus, Issue[]> = {
    open: [],
    doing: [],
    hold: [],
    done: [],
  }
  for (const issue of issues) groups[issue.status]?.push(issue)
  const newestFirst = (a: Issue, b: Issue): number => {
    if (a.created !== b.created) return a.created < b.created ? 1 : -1
    return b.id - a.id
  }
  groups.open.sort(newestFirst)
  groups.doing.sort(newestFirst)
  groups.hold.sort(newestFirst)
  groups.done.sort((a, b) => b.id - a.id)
  return groups
}

/**
 * Cross-project overview rows. `openish` (open+doing+hold) is the
 * "still needs attention" count; rows with the most of it float first.
 */
export function overviewRows(repos: readonly RepoIssues[]): Array<{
  repoRoot: string
  counts: Record<IssueStatus, number>
  total: number
  openish: number
}> {
  return repos
    .map((repo) => {
      const counts: Record<IssueStatus, number> = {
        open: 0,
        doing: 0,
        hold: 0,
        done: 0,
      }
      for (const issue of repo.issues) {
        if (counts[issue.status] !== undefined) counts[issue.status] += 1
      }
      return {
        repoRoot: repo.repoRoot,
        counts,
        total: repo.issues.length,
        openish: counts.open + counts.doing + counts.hold,
      }
    })
    .sort(
      (a, b) => b.openish - a.openish || a.repoRoot.localeCompare(b.repoRoot),
    )
}

/**
 * The engine's first message for a quick-started issue. The caller has
 * already flipped the issue to `doing`; the prompt asks the agent to set
 * it to `done` in docs/issues.json when the work lands.
 */
export function quickStartPrompt(issue: Issue): string {
  const lines = [
    `Work on docs/issues.json issue #${issue.id}: ${issue.title}`,
    "",
  ]
  const body = issue.body.trim()
  if (body) lines.push(body, "")
  lines.push(
    `When the work lands, update docs/issues.json: set issue #${issue.id}'s "status" to "done". Keep the file's formatting (2-space indent, trailing newline) intact.`,
  )
  return lines.join("\n")
}

/* ----- quick start (side-effectful) --------------------------------------- */

/**
 * Spawn a kobe task from an issue: create the task (branch derived later
 * by ensureWorktree — KOB-244; vendor = shared Settings default), mark the issue
 * `doing`, then deliver the prompt through the pty sidecar's
 * spawn-on-send path, which materializes the worktree + engine. The
 * status flip is best-effort: the task already exists, so a write
 * failure must not strand it.
 */
export async function quickStartIssue(
  repoRoot: string,
  issue: Issue,
): Promise<{ taskId: string }> {
  const vendor = await fetchDefaultEngine()
  const { taskId } = await rpc<{ taskId: string }>("task.create", {
    repo: repoRoot,
    title: `#${issue.id} ${issue.title}`,
    ...(vendor ? { vendor } : {}),
  })
  // Move the daemon's active-task pointer too — every sibling open-task
  // path pairs selectTask with this (Board/NewTaskDialog), and the
  // /task/$taskId route effect won't fire it (selectTask runs first).
  void rpc("task.setActive", { taskId }).catch(() => {})
  await setIssueStatus(repoRoot, issue.id, "doing").catch(() => {})
  const { worktreePath } = await rpc<{ worktreePath: string }>(
    "task.ensureWorktree",
    { taskId },
  )
  await syncIssuesToWorktree(repoRoot, worktreePath)
  const tabId = ensureEngineTab(taskId)
  await sendPtyText(tabId, taskId, quickStartPrompt(issue))
  return { taskId }
}
