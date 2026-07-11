/**
 * `landTask` executor — collect a task's branch back into its base repo.
 *
 * The product unit is `Task = worktree + engine session + branch`, and every
 * step of that had a product path EXCEPT the last one: collecting the branch.
 * Every fan-out round ("pick the winner") and every task wrap-up meant leaving
 * kobe to hand-run `git merge` in the main checkout, self-check it was clean,
 * and copy the conflict list by hand. This does that one step.
 *
 * v1 scope (deliberately small — see the orch brief): merge OR squash-merge the
 * task's branch into the base repo's CURRENT branch, in the main checkout.
 * Refuse up front if the main checkout is dirty (same guard shape as
 * `deleteTask`'s {@link DirtyWorktreeError}). On a merge conflict, `git merge
 * --abort` immediately and throw the conflicted-file list — the human resolves
 * it by hand for now (auto-repair-via-engine is v2). Zero new deps: git CLI
 * subprocesses through the same {@link ExecHost} the worktree manager uses.
 */

import type { ExecHost } from "../exec/exec-host.ts"
import type { Task, TaskId } from "../types/task.ts"
import { LandConflictError, MainCheckoutDirtyError } from "./errors.ts"
import { type WorktreeExecDeps, defaultExecDeps } from "./worktree/exec-deps.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"

export type LandStrategy = "merge" | "squash"

export interface LandTaskInput {
  readonly strategy?: LandStrategy
}

/** Options for a full land: strategy + post-land cleanup. */
export interface LandTaskOpts {
  readonly strategy?: LandStrategy
  /** Delete the task's branch after a successful land. */
  readonly deleteBranch?: boolean
  /** Archive the task after a successful land (moves it off the active board). */
  readonly archive?: boolean
}

/** Collaborators `landTaskWithCleanup` drives for the post-land steps. */
export interface LandDeps {
  readonly worktrees: Pick<GitWorktreeManager, "deleteBranch">
  readonly setArchived: (id: TaskId | string, archived: boolean) => Promise<void>
}

/**
 * Land `task`'s branch (via {@link landTask}) and then run the opt-in cleanup:
 * delete the now-landed branch, archive the settled task. The merge has already
 * committed once cleanup runs, so it must stand — a `deleteBranch` failure is
 * best-effort inside `remove`-style deletion, and archiving is a plain store
 * write. Extracted from the orchestrator so `core.ts` stays a thin delegator.
 */
export async function landTaskWithCleanup(task: Task, opts: LandTaskOpts, deps: LandDeps): Promise<LandResult> {
  if (task.kind === "main") throw new Error("landTask: a main task has no branch to land")
  const result = await landTask(task, { strategy: opts.strategy })
  if (opts.deleteBranch) await deps.worktrees.deleteBranch(task.repo, result.branch, { force: true })
  if (opts.archive) await deps.setArchived(task.id, true)
  return result
}

export interface LandResult {
  readonly branch: string
  readonly strategy: LandStrategy
  /** The base repo's branch the work landed on. */
  readonly landedOn: string
  /** Short SHA of the merge/commit that landed the work. */
  readonly commit: string
}

/** Resolve the git working dir + ExecHost for the base repo — local path or remote basePath. */
function baseRepoCtx(repo: string, deps: WorktreeExecDeps): { exec: ExecHost; dir: string } {
  const basePath = deps.remoteBasePath(repo)
  return { exec: deps.execForRepo(repo), dir: basePath ?? repo }
}

async function git(
  exec: ExecHost,
  dir: string,
  args: readonly string[],
): Promise<{ stdout: string; exitCode: number }> {
  const r = await exec.run(["git", ...args], { cwd: dir })
  return { stdout: r.stdout, exitCode: r.exitCode }
}

/** `git status --porcelain` non-empty in `dir` (untracked counts). */
async function isDirty(exec: ExecHost, dir: string): Promise<boolean> {
  return (await git(exec, dir, ["status", "--porcelain"])).stdout.trim().length > 0
}

/** Conflicted paths after a failed merge: `git diff --name-only --diff-filter=U`. */
async function conflictedFiles(exec: ExecHost, dir: string): Promise<string[]> {
  const out = await git(exec, dir, ["diff", "--name-only", "--diff-filter=U"])
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * Land `task`'s branch into its base repo's current branch.
 *
 * Preconditions checked here (fail before any git write):
 *   - the task has a branch to land (a never-materialised task has none);
 *   - the base checkout is clean — a merge into a dirty tree would entangle the
 *     user's in-progress work with the landed branch, so we refuse.
 *
 * On conflict: abort the merge (leaving the base checkout exactly as it was) and
 * throw {@link LandConflictError} with the conflicted paths. On success: return
 * the branch, the base branch it landed on, and the resulting commit's short SHA.
 */
export async function landTask(
  task: Task,
  input: LandTaskInput = {},
  deps: WorktreeExecDeps = defaultExecDeps,
): Promise<LandResult> {
  const branch = task.branch.trim()
  if (!branch) throw new Error(`landTask: task ${task.id} has no branch to land (never materialised)`)
  const strategy: LandStrategy = input.strategy ?? "merge"
  const { exec, dir } = baseRepoCtx(task.repo, deps)

  // The base branch we land onto — surfaced in the result + the merge commit msg.
  const headOut = await git(exec, dir, ["rev-parse", "--abbrev-ref", "HEAD"])
  const landedOn = headOut.stdout.trim()
  if (!landedOn || landedOn === "HEAD") {
    throw new Error(`landTask: base checkout at ${dir} is in detached-HEAD state; check out a branch first`)
  }
  if (landedOn === branch) {
    throw new Error(`landTask: base checkout is already on '${branch}' — nothing to land onto`)
  }

  if (await isDirty(exec, dir)) throw new MainCheckoutDirtyError(task.repo, dir)

  if (strategy === "squash") {
    const merge = await git(exec, dir, ["merge", "--squash", branch])
    if (merge.exitCode !== 0) {
      const files = await conflictedFiles(exec, dir)
      await git(exec, dir, ["merge", "--abort"]).catch(() => {})
      // `--squash` stages without committing; if it half-applied without a
      // clean conflict marker, reset the index/tree back to HEAD.
      await git(exec, dir, ["reset", "--hard", "HEAD"]).catch(() => {})
      throw new LandConflictError(task.id, branch, files)
    }
    const commit = await git(exec, dir, ["commit", "--no-edit", "-m", `Land ${branch} (squash)`])
    if (commit.exitCode !== 0) {
      // Nothing to commit = the branch was already fully in base. Reset the
      // squash's staged index so the base checkout is untouched, and report it.
      await git(exec, dir, ["reset", "--hard", "HEAD"]).catch(() => {})
      throw new Error(`landTask: '${branch}' has nothing to land onto '${landedOn}' (already merged or empty)`)
    }
  } else {
    const before = (await git(exec, dir, ["rev-parse", "HEAD"])).stdout.trim()
    const merge = await git(exec, dir, ["merge", "--no-ff", "-m", `Land ${branch}`, branch])
    if (merge.exitCode !== 0) {
      const files = await conflictedFiles(exec, dir)
      await git(exec, dir, ["merge", "--abort"]).catch(() => {})
      throw new LandConflictError(task.id, branch, files)
    }
    // `git merge --no-ff` on an already-merged/empty branch exits 0 with
    // "Already up to date." and creates NO commit — HEAD does not move. Guard
    // it the same way the squash path guards its empty `git commit`, so both
    // strategies reject a nothing-to-land branch instead of the merge path
    // reporting a fake success on the unchanged base commit.
    const after = (await git(exec, dir, ["rev-parse", "HEAD"])).stdout.trim()
    if (before === after) {
      throw new Error(`landTask: '${branch}' has nothing to land onto '${landedOn}' (already merged or empty)`)
    }
  }

  const shaOut = await git(exec, dir, ["rev-parse", "--short", "HEAD"])
  return { branch, strategy, landedOn, commit: shaOut.stdout.trim() }
}
