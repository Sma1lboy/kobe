import { resolve } from "node:path"
import {
  CodexRunTurnError,
  type RunTurnEvent,
  type RunTurnPurpose,
  normalizeCodexExecApproval,
  normalizeCodexExecSandbox,
} from "../engine/run-turn/codex.ts"
import { runTurn } from "../engine/run-turn/index.ts"
import type { VendorId } from "../types/vendor.ts"

const RUN_TURN_USAGE = [
  "Usage: kobe run-turn [options] [prompt]",
  "",
  "Run one headless engine turn. Codex is wired first via `codex exec --json`.",
  "",
  "Options:",
  "  --vendor <id>      Engine vendor (default: codex; only codex is wired today)",
  "  --worktree <path>  Worktree/repo cwd for the turn (default: current directory)",
  "  --prompt <text>    Prompt text; otherwise positional args or stdin are used",
  "  --small           Use the vendor's small-model runTurn setting",
  "  --model <name>    Override the configured model for this call",
  "  --effort <level>  Codex reasoning effort (none|low|medium|high|xhigh)",
  "  --sandbox <mode>  Codex sandbox (read-only|workspace-write|danger-full-access)",
  "  --approval <mode> Codex approval policy (untrusted|on-failure|on-request|never)",
  "  --ephemeral       Do not persist this Codex exec session",
  "  --json            Print normalized runTurn events as JSONL",
  "  -h, --help        Print this help",
  "",
].join("\n")

interface ParsedRunTurnArgs {
  readonly help: boolean
  readonly vendor: VendorId
  readonly worktree: string
  readonly prompt?: string
  readonly purpose: RunTurnPurpose
  readonly model?: string
  readonly effort?: string
  readonly sandbox?: string
  readonly approval?: string
  readonly ephemeral: boolean
  readonly json: boolean
}

function usageError(message: string): never {
  process.stderr.write(`kobe run-turn: ${message}\n\n${RUN_TURN_USAGE}`)
  process.exit(2)
}

function takeValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) usageError(`${flag} requires a value`)
  return value
}

export function parseRunTurnArgs(args: readonly string[]): ParsedRunTurnArgs {
  let vendor: VendorId = "codex"
  let worktree = process.cwd()
  let prompt: string | undefined
  let purpose: RunTurnPurpose = "default"
  let model: string | undefined
  let effort: string | undefined
  let sandbox: string | undefined
  let approval: string | undefined
  let ephemeral = false
  let json = false
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h" || arg === "help")
      return { help: true, vendor, worktree, purpose, ephemeral, json }
    if (arg === "--vendor") {
      vendor = takeValue(args, i, arg) as VendorId
      i++
      continue
    }
    if (arg === "--worktree" || arg === "--cwd") {
      worktree = resolve(takeValue(args, i, arg))
      i++
      continue
    }
    if (arg === "--prompt") {
      prompt = takeValue(args, i, arg)
      i++
      continue
    }
    if (arg === "--small") {
      purpose = "small"
      continue
    }
    if (arg === "--model") {
      model = takeValue(args, i, arg)
      i++
      continue
    }
    if (arg === "--effort") {
      effort = takeValue(args, i, arg)
      i++
      continue
    }
    if (arg === "--sandbox") {
      sandbox = takeValue(args, i, arg)
      i++
      continue
    }
    if (arg === "--approval") {
      approval = takeValue(args, i, arg)
      i++
      continue
    }
    if (arg === "--ephemeral") {
      ephemeral = true
      continue
    }
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--") {
      positional.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith("-")) usageError(`unknown flag "${arg}"`)
    positional.push(arg)
  }

  return {
    help: false,
    vendor,
    worktree,
    prompt: prompt ?? (positional.length > 0 ? positional.join(" ") : undefined),
    purpose,
    model,
    effort,
    sandbox,
    approval,
    ephemeral,
    json,
  }
}

async function readStdinIfAvailable(): Promise<string> {
  if (process.stdin.isTTY) return ""
  process.stdin.setEncoding("utf8")
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return text
}

function writeEvent(event: RunTurnEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
    return
  }
  if (event.type === "assistant_text") process.stdout.write(event.text)
  else if (event.type === "stderr") process.stderr.write(event.text)
}

export async function runRunTurnSubcommand(args: readonly string[]): Promise<void> {
  const parsed = parseRunTurnArgs(args)
  if (parsed.help) {
    process.stdout.write(RUN_TURN_USAGE)
    return
  }
  const prompt = (parsed.prompt ?? (await readStdinIfAvailable())).trim()
  if (!prompt) usageError("prompt is required")

  const sandbox = normalizeCodexExecSandbox(parsed.sandbox)
  if (parsed.sandbox && !sandbox) usageError(`invalid sandbox "${parsed.sandbox}"`)
  const approval = normalizeCodexExecApproval(parsed.approval)
  if (parsed.approval && !approval) usageError(`invalid approval "${parsed.approval}"`)

  try {
    await runTurn({
      vendor: parsed.vendor,
      worktree: parsed.worktree,
      prompt,
      purpose: parsed.purpose,
      model: parsed.model,
      effort: parsed.effort,
      sandbox,
      approval,
      ephemeral: parsed.ephemeral || parsed.purpose === "small",
      onEvent: (event) => writeEvent(event, parsed.json),
    })
  } catch (err) {
    if (err instanceof CodexRunTurnError) {
      process.exit(err.result.exitCode ?? 1)
    }
    process.stderr.write(`kobe run-turn: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
