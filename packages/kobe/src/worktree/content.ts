/**
 * Worktree content reads.
 *
 * File/preview surfaces need a small, soft-failing way to inspect a Task's
 * Worktree without knowing whether it lives locally or behind SSH. This module
 * is that interface: callers ask for git output or file text, and the
 * local/remote choice stays behind ExecHost.
 */

import type { ExecResult } from "../exec/exec-host.ts"
import { execHostForWorktreePath } from "../exec/resolve.ts"
import { READ_ONLY_GIT_ENV } from "../lib/git-env.ts"

export interface WorktreeGitResult {
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
}

export interface WorktreeContentDeps {
  readonly execForPath?: typeof execHostForWorktreePath
}

export interface RunWorktreeGitOptions extends WorktreeContentDeps {
  readonly timeoutMs?: number
}

/**
 * Run `git <args>` in a Worktree via its ExecHost. Never throws for git
 * failure; spawn/SSH failures come back as `status: -1`, matching the previous
 * spawn-wrapper shape used by pane code.
 */
export async function runWorktreeGit(
  worktreePath: string,
  args: readonly string[],
  options: RunWorktreeGitOptions = {},
): Promise<WorktreeGitResult> {
  if (!worktreePath) {
    return { stdout: "", stderr: "worktreePath is required", status: -1 }
  }
  const exec = (options.execForPath ?? execHostForWorktreePath)(worktreePath)
  const controller = options.timeoutMs && options.timeoutMs > 0 ? new AbortController() : null
  let timedOut = false
  const timer = controller
    ? setTimeout(() => {
        timedOut = true
        controller.abort()
      }, options.timeoutMs)
    : null
  let result: ExecResult
  try {
    result = await exec.run(["git", ...args], {
      cwd: worktreePath,
      env: READ_ONLY_GIT_ENV,
      signal: controller?.signal,
    })
  } catch (err) {
    if (timer) clearTimeout(timer)
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), status: -1 }
  }
  if (timer) clearTimeout(timer)
  if (timedOut && result.exitCode === -1 && !result.stderr) {
    return {
      stdout: result.stdout,
      stderr: `git ${args.join(" ")} timed out after ${options.timeoutMs}ms`,
      status: -1,
    }
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.exitCode,
  }
}

function joinedWorktreePath(worktreePath: string, relPath: string): string | null {
  if (!worktreePath || !relPath || relPath.startsWith("/")) return null
  const parts = relPath.split("/")
  if (parts.some((part) => part === "..")) return null
  return `${worktreePath.replace(/\/+$/, "")}/${parts.filter(Boolean).join("/")}`
}

/**
 * Read a utf8 file inside a Worktree. Invalid relative paths and unreadable
 * files return `null` so UI panes can render an empty/soft state.
 */
export async function readWorktreeFile(
  worktreePath: string,
  relPath: string,
  deps: WorktreeContentDeps = {},
): Promise<string | null> {
  const path = joinedWorktreePath(worktreePath, relPath)
  if (!path) return null
  const exec = (deps.execForPath ?? execHostForWorktreePath)(worktreePath)
  try {
    return await exec.readFile(path)
  } catch {
    return null
  }
}
