/**
 * The remote/local resolver seam for worktree operations — a REMOTE project's
 * git work runs over SSH while a LOCAL project keeps the plain local behavior.
 * Injected into `GitWorktreeManager` so tests can stub remoteness without a
 * real host. See `docs/design/remote-projects.md`.
 */

import type { ExecHost } from "../../exec/exec-host.ts"
import { execHostForRepo, execHostForWorktreePath } from "../../exec/resolve.ts"
import { getRemoteRepoConfig } from "../../state/repos.ts"

export interface WorktreeExecDeps {
  /** ExecHost for a project KEY (local path or `ssh://…`). */
  execForRepo(repoKey: string): ExecHost
  /** ExecHost for a WORKTREE PATH (recovered by basePath match). */
  execForPath(worktreePath: string): ExecHost
  /** The remote base path for a project key, or null when the project is local. */
  remoteBasePath(repoKey: string): string | null
}

export const defaultExecDeps: WorktreeExecDeps = {
  execForRepo: execHostForRepo,
  execForPath: execHostForWorktreePath,
  remoteBasePath(repoKey) {
    return getRemoteRepoConfig(repoKey)?.basePath ?? null
  },
}

/** The git working dir + ExecHost a project key resolves to. */
export interface ExecCtx {
  readonly exec: ExecHost
  /** Directory git runs in: the local repo path, or the remote basePath. */
  readonly dir: string
  readonly remote: boolean
}
