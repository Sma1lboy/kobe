import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"
import type { ModelEffortLevel } from "@/types/engine"
import { normalizeCopilotCliModel } from "./models"

export interface SpawnCopilotOpts {
  readonly binaryPath: string
  readonly cwd: string
  readonly prompt: string
  readonly model?: string
  readonly modelEffort?: ModelEffortLevel
  readonly resumeSessionId?: string
  readonly permissionMode?: "default" | "plan"
  readonly env?: Readonly<Record<string, string>>
  readonly extraArgs?: readonly string[]
}

export interface SpawnedCopilot {
  readonly proc: ChildProcessWithoutNullStreams
  readonly stdout: Readable
  readonly stderr: Readable
  readonly args: readonly string[]
}

export function spawnCopilotProcess(opts: SpawnCopilotOpts): SpawnedCopilot {
  const args = buildArgs(opts)
  const command = buildSpawnCommand(opts.binaryPath, args)
  const proc = spawn(command.file, command.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    ...command.options,
  }) as ChildProcessWithoutNullStreams

  try {
    proc.stdin.end()
  } catch {
    /* spawn error will surface separately */
  }

  return { proc, stdout: proc.stdout, stderr: proc.stderr, args }
}

export interface ProcessSpawnCommand {
  readonly file: string
  readonly args: readonly string[]
  readonly options?: SpawnOptionsWithoutStdio
}

export function buildSpawnCommand(
  binaryPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ProcessSpawnCommand {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(binaryPath)) {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", [binaryPath, ...args].map(quoteForCmd).join(" ")],
    }
  }
  return { file: binaryPath, args }
}

export function buildArgs(opts: SpawnCopilotOpts): string[] {
  const args: string[] = [
    "-C",
    opts.cwd,
    "--output-format",
    "json",
    "--stream",
    "on",
    "--no-color",
    "--no-remote",
    "--no-ask-user",
  ]
  if (opts.resumeSessionId) args.push(`--resume=${opts.resumeSessionId}`)
  const model = normalizeCopilotCliModel(opts.model)
  if (model) args.push("--model", model)
  if (opts.modelEffort) args.push("--effort", opts.modelEffort)
  if (opts.permissionMode === "plan") args.push("--mode", "plan")
  else args.push("--allow-all")
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  args.push("--prompt", opts.prompt)
  return args
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""').replace(/%/g, "%%")}"`
}
