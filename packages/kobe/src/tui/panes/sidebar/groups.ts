import { reconcileStableRows } from "@/tui/lib/stable-rows"
import type { Task } from "@/types/task"
import { fuzzyMatch } from "./fuzzy"

export type SidebarView = "active" | "archived"
export type TaskSortMode = "default" | "recent"

export type SidebarRow = { kind: "task"; task: Task; flatIndex: number }
export type SidebarProjectOption = { repo: string; label: string; count: number }
export type SidebarRowSections = {
  projectRows: SidebarRow[]
  taskRows: SidebarRow[]
}

export function filterByView(tasks: readonly Task[], view: SidebarView): Task[] {
  const wantArchived = view === "archived"
  return tasks.filter((t) => t.archived === wantArchived)
}

export function buildRows(
  tasks: readonly Task[],
  view: SidebarView,
  searchQuery?: string,
  sortMode: TaskSortMode = "default",
  projectFilter?: string | null,
): SidebarRow[] {
  const filteredByView = filterByView(tasks, view)
  const q = searchQuery?.trim() ?? ""
  const projectKey = projectFilter ? sidebarProjectKey(projectFilter) : null
  const filtered = q
    ? filteredByView.filter((t) => fuzzyMatch(q, `${t.title} ${repoBasename(t.repo)}`))
    : filteredByView
  const main: Task[] = []
  const pinnedRegular: Task[] = []
  const regular: Task[] = []
  const seenMainRepos = new Set<string>()
  for (const t of filtered) {
    if (t.kind === "main") {
      const key = sidebarProjectKey(t.repo)
      if (seenMainRepos.has(key)) continue
      seenMainRepos.add(key)
      main.push(t)
      continue
    }
    if (projectKey && sidebarProjectKey(t.repo) !== projectKey) continue
    if (t.pinned === true) pinnedRegular.push(t)
    else regular.push(t)
  }
  main.sort((a, b) => repoBasename(a.repo).localeCompare(repoBasename(b.repo)))
  if (sortMode === "recent") {
    pinnedRegular.sort(compareRecent)
    regular.sort(compareRecent)
  }
  const rows: SidebarRow[] = []
  let flatIndex = 0
  for (const task of main) {
    rows.push({ kind: "task", task, flatIndex })
    flatIndex++
  }
  for (const task of pinnedRegular) {
    rows.push({ kind: "task", task, flatIndex })
    flatIndex++
  }
  for (const task of regular) {
    rows.push({ kind: "task", task, flatIndex })
    flatIndex++
  }
  return rows
}

function compareRecent(a: Task, b: Task): number {
  const byTime = taskTime(b) - taskTime(a)
  if (byTime !== 0) return byTime
  return String(b.id).localeCompare(String(a.id))
}

function taskTime(task: Task): number {
  const parsed = Date.parse(task.updatedAt || task.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

export function repoBasename(repo: string): string {
  const segments = repo.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? repo
}

export function sidebarProjectKey(repo: string): string {
  const trimmed = repo.trim().replace(/[\\/]+$/, "")
  return trimmed || repo
}

export function sidebarProjectLabel(repo: string, repos: readonly string[]): string {
  const base = repoBasename(repo)
  const collides = repos.some((r) => r !== repo && repoBasename(r) === base)
  if (!collides) return base
  return repo
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .slice(-2)
    .join("/")
}

export function buildProjectOptions(tasks: readonly Task[], view: SidebarView): SidebarProjectOption[] {
  const wantArchived = view === "archived"
  const byKey = new Map<string, { repo: string; count: number }>()
  for (const task of tasks) {
    const key = sidebarProjectKey(task.repo)
    const next = byKey.get(key) ?? { repo: task.repo, count: 0 }
    if (task.kind === "main") {
      next.repo = task.repo
    } else if (task.archived === wantArchived) {
      next.count += 1
    }
    byKey.set(key, next)
  }
  const repos = [...byKey.values()].map((entry) => entry.repo)
  return [...byKey.values()]
    .map((entry) => ({
      repo: entry.repo,
      label: sidebarProjectLabel(entry.repo, repos),
      count: entry.count,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function cursorIndexForProjectScope(rows: readonly SidebarRow[], projectFilter?: string | null): number {
  if (rows.length === 0) return -1
  if (!projectFilter) return rows[0]?.flatIndex ?? -1
  const projectKey = sidebarProjectKey(projectFilter)
  const firstTask = rows.find((row) => row.task.kind !== "main" && sidebarProjectKey(row.task.repo) === projectKey)
  if (firstTask) return firstTask.flatIndex
  const projectRow = rows.find((row) => row.task.kind === "main" && sidebarProjectKey(row.task.repo) === projectKey)
  return projectRow?.flatIndex ?? rows[0]?.flatIndex ?? -1
}

export function flattenIds(rows: readonly SidebarRow[]): string[] {
  return rows.map((r) => r.task.id)
}

export function resolveCursorTarget(selectedId: string | null, flatIds: readonly string[], cursor: number): number {
  const len = flatIds.length
  if (selectedId === null) {
    if (cursor === -1 && len > 0) return 0
    if (cursor >= len) return Math.max(0, len - 1)
    if (len === 0) return -1
    return cursor
  }
  const idx = flatIds.indexOf(selectedId)
  if (idx >= 0) return idx
  if (len === 0) return -1
  if (cursor < 0 || cursor >= len) return len - 1
  return cursor
}

export function splitSidebarRows(rows: readonly SidebarRow[]): SidebarRowSections {
  const projectRows: SidebarRow[] = []
  const taskRows: SidebarRow[] = []
  for (const row of rows) {
    if (row.task.kind === "main") projectRows.push(row)
    else taskRows.push(row)
  }
  return { projectRows, taskRows }
}

export function sameSidebarRowTask(a: Task, b: Task): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.kind === b.kind &&
      a.title === b.title &&
      a.repo === b.repo &&
      a.branch === b.branch &&
      a.worktreePath === b.worktreePath &&
      a.status === b.status &&
      a.archived === b.archived &&
      a.pinned === b.pinned &&
      a.vendor === b.vendor)
  )
}

export function reconcileSidebarRows(prev: readonly SidebarRow[], next: readonly SidebarRow[]): readonly SidebarRow[] {
  return reconcileStableRows(
    prev,
    next,
    (row) => row.task.id,
    (a, b) => a.flatIndex === b.flatIndex && sameSidebarRowTask(a.task, b.task),
    { samePosition: true },
  )
}
