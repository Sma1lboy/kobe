export interface WorktreeInfo {
  readonly path: string
  readonly branch: string
  readonly head: string
  readonly dirty: boolean
}

export interface AdoptableWorktree {
  readonly path: string
  readonly branch: string
  readonly head: string
  readonly dirty: boolean
  readonly kobeManaged: boolean
  readonly lastActivityMs: number
}

export interface WorktreeAuditRow extends AdoptableWorktree {
  readonly repo: string
  readonly createdAtMs: number
  readonly branchOnRemote: boolean | null
}

export interface WorktreeProject {
  readonly repo: string
  readonly worktrees: readonly WorktreeAuditRow[]
}

export interface WorktreeManager {
  create(repo: string, branch: string, path: string, baseRef?: string): Promise<WorktreeInfo>

  remove(path: string, opts?: { readonly force?: boolean }): Promise<void>

  list(repo: string): Promise<readonly WorktreeInfo[]>

  isDirty(path: string): Promise<boolean>

  currentBranch(path: string): Promise<string>
}
