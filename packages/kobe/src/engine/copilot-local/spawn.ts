/**
 * Subprocess wrapper around GitHub Copilot CLI prompt mode.
 *
 * Official Copilot CLI docs define prompt mode (`-p`), JSONL output
 * (`--output-format=json`), cwd selection (`-C`), model pinning
 * (`--model`), reasoning effort (`--reasoning-effort`), plan mode
 * (`--mode plan`), and non-interactive permission flags. kobe passes a
 * generated UUID via `--resume=<uuid>` on first spawn because Copilot
 * supports that form for starting a named session, and it gives kobe a
 * stable session id before the first JSONL line arrives.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"
import type { ModelEffortLevel } from "@/types/engine"

export interface SpawnCopilotOpts {
  readonly binaryPath: string
  readonly cwd: string
  readonly prompt: string
  readonly sessionId: string
  readonly model?: string
  readonly modelEffort?: ModelEffortLevel
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

export function buildArgs(opts: SpawnCopilotOpts): string[] {
  const args = [
    "-C",
    opts.cwd,
    "--resume",
    opts.sessionId,
    "--output-format",
    "json",
    "--stream",
    "on",
    "--no-auto-update",
    "--no-ask-user",
  ]

  if (opts.model) args.push("--model", opts.model)
  if (opts.modelEffort && opts.modelEffort !== "none" && opts.modelEffort !== "minimal" && opts.modelEffort !== "max") {
    args.push("--reasoning-effort", opts.modelEffort)
  }
  if (opts.permissionMode === "plan") {
    args.push("--mode", "plan")
  } else {
    args.push("--allow-all")
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  args.push("-p", opts.prompt)
  return args
}
