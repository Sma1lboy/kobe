import type { Task } from "../../types/task.ts"

export function activeTaskSessionId(task: Task | undefined, activeChatTabId: string | null | undefined): string | null {
  if (!task) return null
  const tabId = activeChatTabId ?? task.activeTabId
  return task.tabs.find((tab) => tab.id === tabId)?.sessionId ?? null
}

export function activeTaskRepoBranchLabel(task: Task | undefined): string {
  if (!task) return "no task"
  const repoName = repoBasename(task.repo)
  const branch = task.branch.trim()
  if (!repoName) return branch || task.title || "untitled"
  if (!branch) return repoName
  return `${repoName} / ${branch}`
}

function repoBasename(repo: string): string {
  const segments = repo.split(/[\\/]+/).filter(Boolean)
  return segments[segments.length - 1] ?? repo
}
