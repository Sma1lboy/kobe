import { spawnSync } from "node:child_process"

export interface GitRunOpts {
  readonly cwd: string
  readonly allowFail?: boolean
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

export function git(args: readonly string[], opts: GitRunOpts): GitRunResult {
  if (!opts.cwd) {
    throw new Error("git(): cwd is required; refusing to inherit from process.cwd()")
  }

  const proc = spawnSync("git", [...args], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: "utf8",
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
