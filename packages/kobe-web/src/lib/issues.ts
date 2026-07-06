import { setActiveTaskBestEffort } from "./active-task.ts"
import { api } from "./api-client.ts"
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
  taskId?: string
}

export interface RepoIssues {
  repoRoot: string
  exists: boolean
  nextId: number
  issues: Issue[]
}

export async function fetchProjects(): Promise<string[]> {
  const data = await api.get<{ projects?: unknown }>("/api/projects", {
    label: "load projects",
  })
  return Array.isArray(data.projects)
    ? data.projects.filter((repo): repo is string => typeof repo === "string")
    : []
}

export interface IssueRepoOption {
  readonly repo: string
  readonly label: string
  readonly count: number
}

export async function fetchIssues(repoRoot: string): Promise<RepoIssues> {
  return api.get<RepoIssues>("/api/issues", {
    query: { repoRoot },
    label: "load issues",
  })
}

async function postOp(repoRoot: string, op: unknown): Promise<RepoIssues> {
  return api.post<RepoIssues>(
    "/api/issues",
    { repoRoot, op },
    { label: "update issues" },
  )
}

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

export async function linkIssue(
  repoRoot: string,
  id: number,
  taskId: string,
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "link", id, taskId })
}

export async function unlinkIssue(
  repoRoot: string,
  id: number,
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "unlink", id })
}

export async function deleteIssue(
  repoRoot: string,
  id: number,
): Promise<RepoIssues> {
  return postOp(repoRoot, { type: "delete", id })
}

async function fetchKobeApiInvocation(): Promise<string> {
  const data = await api.getOr<{ api?: unknown }>(
    "/api/cli-invocation",
    {},
    { label: "load CLI invocation" },
  )
  return typeof data.api === "string" && data.api.trim().length > 0
    ? data.api
    : "kobe api"
}

export const ISSUE_STATUSES: readonly IssueStatus[] = [
  "open",
  "doing",
  "hold",
  "done",
]

export const STATUS_META: Record<
  IssueStatus,
  { title: string; accent: string }
> = {
  open: { title: "Backlog", accent: "text-kobe-blue" },
  doing: { title: "In session", accent: "text-kobe-orange" },
  hold: { title: "Blocked", accent: "text-kobe-yellow" },
  done: { title: "Done", accent: "text-kobe-green" },
}

export function canQuickStart(status: IssueStatus): boolean {
  return status !== "done"
}

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

export function issueMergePrompt(issue: Issue, api = "kobe api"): string {
  return [
    `Finish user story #${issue.id}: ${issue.title}`,
    "",
    "Verify the acceptance criteria implied by the story, then summarize what changed and any verification still needed.",
    "Then merge this task branch back into the current project's main branch after the worktree is clean and checks pass. Resolve conflicts if needed.",
    `When the work lands, run: ${api} issue-set-status --repo . --id ${issue.id} --status done`,
  ].join("\n")
}

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
  setActiveTaskBestEffort(taskId)
  await linkIssue(repoRoot, issue.id, taskId).catch(() => {})
  const api = await fetchKobeApiInvocation().catch(() => "kobe api")
  const tabId = ensureEngineTab(taskId)
  await sendPtyText(tabId, taskId, quickStartPrompt(issue, api))
  return { taskId }
}

export async function promptIssueMerge(
  taskId: string,
  issue: Issue,
): Promise<void> {
  const api = await fetchKobeApiInvocation().catch(() => "kobe api")
  const tabId = ensureEngineTab(taskId)
  await sendPtyText(tabId, taskId, issueMergePrompt(issue, api))
}
