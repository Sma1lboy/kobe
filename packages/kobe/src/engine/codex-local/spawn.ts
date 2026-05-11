/**
 * Subprocess wrapper around the local `codex` CLI.
 *
 * Mirrors `claude-code-local/spawn.ts` but builds the args for
 * `codex exec --json` (line-delimited JSON event protocol). For resume
 * we use `codex exec resume <sid> <prompt>` form.
 *
 * Args we pass:
 *   exec [resume <sid>] --json --skip-git-repo-check
 *   [-C <cwd>] [-m <model>] [-s <sandbox> | --dangerously-bypass-approvals-and-sandbox]
 *   <prompt>
 *
 * Trust mode mapping (from kobe's neutral PermissionMode):
 *   "default" → --dangerously-bypass-approvals-and-sandbox  (opcode-style
 *               trust: kobe's UI already runs in a worktree we own)
 *   "plan"    → -s read-only  (the closest codex analog — no writes, no
 *               shell — until codex grows a real plan flag)
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"

export interface SpawnCodexOpts {
  readonly binaryPath: string
  readonly cwd: string
  readonly prompt: string
  readonly model?: string
  readonly resumeSessionId?: string
  /** kobe's neutral mode; mapped onto codex flags inside this module. */
  readonly permissionMode?: "default" | "plan"
  readonly env?: Readonly<Record<string, string>>
  readonly extraArgs?: readonly string[]
}

export interface SpawnedCodex {
  readonly proc: ChildProcessWithoutNullStreams
  readonly stdout: Readable
  readonly stderr: Readable
  readonly args: readonly string[]
}

export function spawnCodexProcess(opts: SpawnCodexOpts): SpawnedCodex {
  const args = buildArgs(opts)
  const proc = spawn(opts.binaryPath, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams

  // Codex prints "Reading additional input from stdin..." and waits even
  // when the prompt is supplied as an argument. Closing stdin tells it
  // to proceed with just the positional prompt.
  try {
    proc.stdin.end()
  } catch {
    /* race with spawn failure — error event will surface separately */
  }

  return {
    proc,
    stdout: proc.stdout,
    stderr: proc.stderr,
    args,
  }
}

export function buildArgs(opts: SpawnCodexOpts): string[] {
  const args: string[] = ["exec"]
  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId)
  }
  args.push("--json", "--skip-git-repo-check")
  // Codex defaults its cwd to the spawn cwd, but we pass -C explicitly
  // for parity with claude-code-local (no surprises if a future caller
  // forgets the cwd: opts.cwd in node spawn options).
  args.push("-C", opts.cwd)
  if (opts.model) {
    args.push("-m", opts.model)
  }
  // Trust mode mapping. See module header.
  if (opts.permissionMode === "plan") {
    args.push("-s", "read-only")
  } else {
    args.push("--dangerously-bypass-approvals-and-sandbox")
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs)
  }
  // Prompt as the trailing positional. Must come last so it isn't
  // interpreted as an option value.
  args.push(opts.prompt)
  return args
}
