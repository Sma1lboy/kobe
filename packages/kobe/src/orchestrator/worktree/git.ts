/**
 * Thin wrapper around `git` invocations for the worktree manager.
 *
 * Invariants this module enforces (so callers can't break them):
 *   - Args are always passed as an array. Never a shell string. We do
 *     not invoke any spawn variant with `shell: true`; we never let
 *     user input reach a shell parser.
 *   - `cwd` is set explicitly on every call. The manager never relies
 *     on `process.cwd()` because it is reentrant — callers might be
 *     running concurrent operations in different repos.
 *   - Non-zero exit codes throw by default. The two callers that need
 *     "soft failure" (e.g. `is this a worktree?` probes) opt in via
 *     `allowFail: true` and inspect the returned `exitCode`.
 *
 * Implementation note: we use Node's `child_process.spawnSync`, not
 * `Bun.spawnSync`, because the test runner (vitest) hosts under Node
 * and `Bun` is undefined there. Node's API is available in both
 * runtimes, so this stays portable when Bun runs the production code
 * path. Every git call here is short-lived (subseconds), so synchronous
 * spawn is the right primitive.
 */

import { spawnSync } from "node:child_process"

export interface GitRunOpts {
  /** Working directory for git. Required — we never default. */
  readonly cwd: string
  /** When true, non-zero exit codes return a result instead of throwing. */
  readonly allowFail?: boolean
  /** Extra environment to merge with `process.env`. */
  readonly env?: Readonly<Record<string, string>>
}

export interface GitRunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export class GitCommandError extends Error {
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string

  constructor(args: readonly string[], cwd: string, result: GitRunResult) {
    super(
      `git ${args.join(" ")} (cwd=${cwd}) exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    )
    this.name = "GitCommandError"
    this.args = args
    this.cwd = cwd
    this.exitCode = result.exitCode
    this.stdout = result.stdout
    this.stderr = result.stderr
  }
}

/**
 * Run `git <args>` synchronously in `opts.cwd`.
 *
 * Throws {@link GitCommandError} on non-zero exit unless
 * `opts.allowFail` is set, in which case the caller is responsible for
 * inspecting `result.exitCode`.
 */
export function git(args: readonly string[], opts: GitRunOpts): GitRunResult {
  if (!opts.cwd) {
    throw new Error("git(): cwd is required; refusing to inherit from process.cwd()")
  }

  const proc = spawnSync("git", [...args], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: "utf8",
    // Refuse to fall back to a shell parser. `args` is already an
    // array; if the host adds `shell: true` somewhere upstream, this
    // setting is overridden, so the array form is the real defense.
    shell: false,
  })

  const result: GitRunResult = {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    exitCode: proc.status ?? -1,
  }

  if (result.exitCode !== 0 && !opts.allowFail) {
    throw new GitCommandError(args, opts.cwd, result)
  }

  return result
}
