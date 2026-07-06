export function normalizeRepoPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

export interface RepoPaths {
  readonly repo: string
  readonly worktreePath: string
}

export function repoSnapshotAliases(
  tasks: readonly RepoPaths[],
  repoRoot: string,
): string[] {
  const root = normalizeRepoPath(repoRoot)
  const aliases = new Set<string>([repoRoot])
  for (const task of tasks) {
    const taskRepo = normalizeRepoPath(task.repo)
    const taskWorktree = normalizeRepoPath(task.worktreePath)
    if (taskRepo === root || taskWorktree === root) {
      if (task.repo) aliases.add(task.repo)
      if (task.worktreePath) aliases.add(task.worktreePath)
    }
  }
  return [...aliases]
}

export function pruneSnapshotAliases<T>(
  snapshots: Record<string, T>,
  tasks: readonly RepoPaths[],
): Record<string, T> {
  const live = new Set<string>()
  for (const task of tasks) {
    if (task.repo) live.add(normalizeRepoPath(task.repo))
    if (task.worktreePath) live.add(normalizeRepoPath(task.worktreePath))
  }
  const kept = Object.entries(snapshots).filter(([key]) =>
    live.has(normalizeRepoPath(key)),
  )
  return kept.length === Object.keys(snapshots).length
    ? snapshots
    : Object.fromEntries(kept)
}
