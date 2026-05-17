import type { Task } from "../../types/task.ts"

export function activeTaskSessionId(task: Task | undefined, activeChatTabId: string | null | undefined): string | null {
  if (!task) return null
  const tabId = activeChatTabId ?? task.activeTabId
  return task.tabs.find((tab) => tab.id === tabId)?.sessionId ?? null
}

export type ActiveTaskTopBarParts = {
  readonly repoName: string
  readonly branch: string
}

export function activeTaskTopBarParts(task: Task | undefined): ActiveTaskTopBarParts | null {
  if (!task) return null
  const repoName = repoBasename(task.repo)
  const branch = task.branch.trim()
  if (!repoName && !branch) return null
  return { repoName, branch }
}

function repoBasename(repo: string): string {
  const segments = repo.split(/[\\/]+/).filter(Boolean)
  return segments[segments.length - 1] ?? repo
}
