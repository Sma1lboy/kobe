import type { Task } from "../../types/task.ts"

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
