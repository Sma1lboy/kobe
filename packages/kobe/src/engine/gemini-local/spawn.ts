import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"

export interface SpawnGeminiOpts {
  readonly binaryPath: string
  readonly cwd: string
  readonly prompt: string
  readonly model?: string
  readonly resumeSessionId?: string
  readonly permissionMode?: "default" | "plan"
  readonly env?: Readonly<Record<string, string>>
  readonly extraArgs?: readonly string[]
}

export interface SpawnedGemini {
  readonly proc: ChildProcessWithoutNullStreams
  readonly stdout: Readable
  readonly stderr: Readable
  readonly args: readonly string[]
}

export function spawnGeminiProcess(opts: SpawnGeminiOpts): SpawnedGemini {
  const args = buildArgs(opts)
  const proc = spawn(opts.binaryPath, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams
  try {
    proc.stdin.end()
  } catch {
    /* spawn error will surface separately */
  }
  return { proc, stdout: proc.stdout, stderr: proc.stderr, args }
}

export function buildArgs(opts: SpawnGeminiOpts): string[] {
  const args: string[] = ["--output-format", "stream-json", "--skip-trust"]
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId)
  if (opts.model) args.push("--model", opts.model)
  args.push("--approval-mode", opts.permissionMode === "plan" ? "plan" : "yolo")
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  args.push("--prompt", opts.prompt)
  return args
}
