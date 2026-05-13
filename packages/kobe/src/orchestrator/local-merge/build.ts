/**
 * Gather git state for the local-merge prompt.
 *
 * All git calls use arg arrays, never shell strings. Failures degrade to
 * conservative defaults so the agent still receives a usable instruction.
 */

import { spawnSync } from "node:child_process"
import type { Task } from "../../types/task.ts"
import type { LocalMergeState } from "./instructions.ts"

const GIT_TIMEOUT_MS = 5_000

function git(cwd: string, args: readonly string[]): string | null {
  try {
    const out = spawnSync("git", args.slice(), {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    })
    if (out.error) return null
    if (out.status !== 0) return null
    return (out.stdout ?? "").trim()
  } catch {
    return null
  }
}

function currentBranch(cwd: string): string {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD"
}

function dirtyCount(cwd: string): number {
  const out = git(cwd, ["status", "--porcelain"])
  if (!out) return 0
  return out.split("\n").filter((line) => line.length > 0).length
}

export async function gatherLocalMergeState(task: Task): Promise<LocalMergeState> {
  return {
    title: task.title,
    sourceWorktree: task.worktreePath,
    sourceBranch: task.branch || currentBranch(task.worktreePath),
    targetRepo: task.repo,
    targetBranch: currentBranch(task.repo),
    sourceDirtyCount: dirtyCount(task.worktreePath),
    targetDirtyCount: dirtyCount(task.repo),
  }
}
