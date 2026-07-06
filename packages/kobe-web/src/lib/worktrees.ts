import { ApiError, api } from "./api-client.ts"

export interface WorktreeRow {
  path: string
  branch: string
  head: string
  dirty: boolean
  kobeManaged: boolean
  lastActivityMs: number
  repo: string
  createdAtMs: number
  branchOnRemote: boolean | null
}

export interface WorktreeProject {
  repo: string
  worktrees: WorktreeRow[]
}

export class DirtyWorktreeError extends Error {}

export async function fetchWorktreeProjects(): Promise<WorktreeProject[]> {
  const data = await api.get<{ projects?: unknown }>("/api/worktrees", {
    label: "load worktrees",
  })
  return Array.isArray(data.projects)
    ? (data.projects as WorktreeProject[])
    : []
}

export async function removeWorktree(
  path: string,
  force: boolean,
): Promise<void> {
  try {
    await api.delete<{ removed: boolean }>(
      "/api/worktrees",
      { path, force },
      { label: "delete worktree" },
    )
  } catch (err) {
    if (
      err instanceof ApiError &&
      /refusing to remove dirty worktree/.test(err.detail)
    ) {
      throw new DirtyWorktreeError(err.detail)
    }
    throw err
  }
}
