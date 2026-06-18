/**
 * Issues API client + pure helpers — talks to the bridge's /api/issues
 * routes, which proxy to the daemon-owned issue store. Also owns quick-start:
 * spawning a kobe task from an issue via the existing task-creation + PTY
 * plumbing.
 */

import { labelRepo } from "./board.ts"
import { fetchDefaultEngine } from "./settings.ts"
import { rpc } from "./store.ts"
import { ensureEngineTab } from "./tabs.ts"
import { sendPtyText } from "./terminal.ts"
import type { Task } from "./types.ts"

export type IssueStatus = "open" | "doing" | "hold" | "done"

export interface Issue {
  id: number
  title: string
  status: IssueStatus
  created: string
  body: string
  /** Task this issue was quick-started into — kept in sync with the web
   *  Task interface (lib/types.ts). A live task here hides the issue from the
   *  unified board. */
  taskId?: string
}

export interface RepoIssues {
  repoRoot: string
  exists: boolean
  nextId: number
  issues: Issue[]
}

export async function fetchProjects(): Promise<string[]> {
  const res = await fetch("/api/projects")
  if (!res.ok) await failWith(res, "load projects")
  const data = (await res.json()) as { projects?: unknown }
  return Array.isArray(data.projects)
    ? data.projects.filter((repo): repo is string => typeof repo === "string")
    : []
}

export interface IssueRepoOption {
  /** Canonical source repo path; worktree checkouts fold into this key. */
  readonly repo: string
  /** Short display name: path basename, parent/basename on collision. */
  readonly label: string
  /** Non-archived tasks currently associated with this repo. */
  readonly count: number
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

/** Link an issue to the task spawned from it — the daemon stamps the issue's
 *  `taskId` (and mirrors the issue to `done` when the task hits done). The
 *  unified board uses this link to dedup the issue against its task card. */
export async function linkIssue(
  repoRoot: string,
  id: number,
  taskId: string,
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "link", id, taskId })
}

/** Drop an issue↔task link — resurfaces the issue on the board (e.g. its task
 *  was deleted). */
export async function unlinkIssue(
  repoRoot: string,
  id: number,
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "unlink", id })
}

/** Remove an issue from the daemon-owned tracker. This deletes ONLY the issue
 *  record — any task, branch, worktree, or engine session it was linked to is
 *  left untouched. */
export async function deleteIssue(
  repoRoot: string,
  id: number,
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "delete", id })
}

async function fetchKobeApiInvocation(): Promise<string> {
  const res = await fetch("/api/cli-invocation")
  if (!res.ok) return "kobe api"
  const data = (await res.json()) as { api?: unknown }
  return typeof data.api === "string" && data.api.trim().length > 0
    ? data.api
    : "kobe api"
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
  open: { title: "Backlog", accent: "text-kobe-blue" },
  doing: { title: "In session", accent: "text-kobe-orange" },
  hold: { title: "Blocked", accent: "text-kobe-yellow" },
  done: { title: "Done", accent: "text-kobe-green" },
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
 * Distinct source repos for the Issues lens. Unlike the Board, Issues are
 * keyed by the repository's shared daemon store, so task worktrees must fold
 * back into `task.repo` instead of appearing as separate projects. Labels
 * come from the shared {@link labelRepo} helper (board.ts).
 */
export function issueRepoOptions(
  tasks: readonly Task[],
  projectRepos: readonly string[] = [],
): IssueRepoOption[] {
  const counts = new Map<string, number>()
  for (const repo of projectRepos) {
    if (repo.trim().length > 0) counts.set(repo, 0)
  }
  const mainRepos = new Set(
    tasks
      .filter((task) => !task.archived && task.kind === "main" && task.repo)
      .map((task) => task.repo),
  )
  for (const repo of mainRepos) counts.set(repo, counts.get(repo) ?? 0)
  const knownProjects = new Set(counts.keys())
  for (const task of tasks) {
    if (task.archived || !task.repo) continue
    if (knownProjects.size > 0 && !knownProjects.has(task.repo)) continue
    counts.set(task.repo, (counts.get(task.repo) ?? 0) + 1)
  }
  const repos = [...counts.keys()]
  return repos
    .map((repo) => ({
      repo,
      label: labelRepo(repo, repos),
      count: counts.get(repo) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Resolve the current project for issue/board surfaces. A project selection is
 * mandatory whenever projects exist: issue execution creates a worktree under
 * this repo, and follow-up merge instructions target this repo's main branch.
 */
export function resolveIssueRepoSelection(
  options: readonly IssueRepoOption[],
  current: string | null,
): string | null {
  if (options.length === 0) return null
  if (current && options.some((option) => option.repo === current)) {
    return current
  }
  return options[0]?.repo ?? null
}

/**
 * The engine's first message for a quick-started issue. The caller has
 * already flipped the issue to `doing`; the prompt asks the agent to report
 * completion through the daemon-owned issue API, not by editing repo files.
 */
export function quickStartPrompt(issue: Issue, api = "kobe api"): string {
  const lines = [`Work on user story #${issue.id}: ${issue.title}`, ""]
  const body = issue.body.trim()
  if (body) lines.push(body, "")
  lines.push(
    "Treat this as the story's dedicated kobe task session: work only in this task worktree, and preserve any repo init instructions already delivered to the session.",
    "Before finishing, verify the acceptance criteria implied by the story and summarize what changed plus any verification still needed.",
    "Then merge the task branch back into the current project's main branch after the worktree is clean and checks pass.",
    `When the work lands, run: ${api} issue-set-status --repo . --id ${issue.id} --status done`,
  )
  return lines.join("\n")
}

/**
 * Follow-up prompt for a linked issue after implementation has run in its task
 * worktree. This is intentionally delivered to the task session instead of
 * merging in the web UI: the engine owns the final code/check/conflict work.
 */
export function issueMergePrompt(issue: Issue, api = "kobe api"): string {
  return [
    `Finish user story #${issue.id}: ${issue.title}`,
    "",
    "Verify the acceptance criteria implied by the story, then summarize what changed and any verification still needed.",
    "Then merge this task branch back into the current project's main branch after the worktree is clean and checks pass. Resolve conflicts if needed.",
    `When the work lands, run: ${api} issue-set-status --repo . --id ${issue.id} --status done`,
  ].join("\n")
}

/* ----- quick start (side-effectful) --------------------------------------- */

/**
 * Spawn a kobe task from an issue: create the task (branch derived later by
 * ensureWorktree — KOB-244), then link the issue → new task one-way via
 * {@link linkIssue} (the daemon stamps `Issue.taskId`, flips the issue `doing`,
 * and mirrors it to `done` when the task finishes), then deliver the prompt
 * through the pty sidecar's spawn-on-send path, which materializes the worktree
 * + engine.
 *
 * The task no longer reverse-references the issue: `Task.issueId` was dropped,
 * so `task.create` carries no `issueId` — `Issue.taskId` (set by `linkIssue`)
 * is the only link, and the daemon's done-mirror is a reverse lookup over it.
 *
 * `vendor` is the engine chosen in the drawer; when omitted it falls back to
 * the shared Settings default. `effort` is the engine's reasoning/effort level
 * (engines that expose none pass `undefined`); it rides the create payload
 * under the `effort` key. The link is best-effort: the task already exists, so
 * a write failure must not strand it.
 */
export async function quickStartIssue(
  repoRoot: string,
  issue: Issue,
  vendor?: string,
  effort?: string,
): Promise<{ taskId: string }> {
  const engine = vendor?.trim() || (await fetchDefaultEngine())
  const { taskId } = await rpc<{ taskId: string }>("task.create", {
    repo: repoRoot,
    title: `#${issue.id} ${issue.title}`,
    ...(engine ? { vendor: engine } : {}),
    ...(effort?.trim() ? { effort: effort.trim() } : {}),
  })
  // Move the daemon's active-task pointer too — every sibling open-task
  // path pairs selectTask with this (Board/NewTaskDialog), and the
  // /task/$taskId route effect won't fire it (selectTask runs first).
  void rpc("task.setActive", { taskId }).catch(() => {})
  // Link issue → task: stamps the issue's taskId, flips it `doing`, and arms
  // the daemon's auto-mirror to `done` when the task completes.
  await linkIssue(repoRoot, issue.id, taskId).catch(() => {})
  const api = await fetchKobeApiInvocation().catch(() => "kobe api")
  const tabId = ensureEngineTab(taskId)
  await sendPtyText(tabId, taskId, quickStartPrompt(issue, api))
  return { taskId }
}

/** Insert the merge/finish follow-up prompt into an issue's linked task. */
export async function promptIssueMerge(
  taskId: string,
  issue: Issue,
): Promise<void> {
  const api = await fetchKobeApiInvocation().catch(() => "kobe api")
  const tabId = ensureEngineTab(taskId)
  await sendPtyText(tabId, taskId, issueMergePrompt(issue, api))
}
