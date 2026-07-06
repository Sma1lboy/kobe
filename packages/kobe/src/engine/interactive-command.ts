import { randomUUID } from "node:crypto"
import { kobeCliInvocation } from "@/cli/invocation"
import { engineEntry } from "@/engine/registry"
import { autoStatusEnabled } from "@/state/auto-status"
import { dispatcherEnabled } from "@/state/dispatcher"
import { getPersistedString } from "@/state/repos"
import type { VendorId } from "@/types/task"
import { BUILTIN_VENDORS } from "@/types/vendor"

export const VENDOR_LABEL: Record<VendorId, string> = Object.fromEntries(
  BUILTIN_VENDORS.map((v) => [v, engineEntry(v).displayName]),
) as Record<VendorId, string>

export function engineCommandKey(vendor: VendorId): string {
  return `engineCommand.${vendor}`
}

export function engineNameKey(vendor: VendorId): string {
  return `engineName.${vendor}`
}

export function engineDisplayName(vendor: VendorId): string {
  const override = getPersistedString(engineNameKey(vendor))?.trim()
  return override || VENDOR_LABEL[vendor] || vendor
}

export function defaultEngineCommand(vendor: VendorId | undefined): readonly string[] {
  return engineEntry(vendor ?? "claude").defaultCommand
}

export function parseEngineCommand(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(command); m !== null; m = re.exec(command)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "")
  }
  return out
}

export function interactiveEngineCommand(vendor: VendorId | undefined, effort?: string): readonly string[] {
  const v: VendorId = vendor ?? "claude"
  const override = getPersistedString(engineCommandKey(v))?.trim()
  const base = (() => {
    if (override) {
      const argv = parseEngineCommand(override)
      if (argv.length > 0) return argv
    }
    return defaultEngineCommand(v)
  })()
  return withEngineEffort(base, v, effort)
}

export function withEngineEffort(
  argv: readonly string[],
  vendor: VendorId | undefined,
  effort: string | undefined,
): readonly string[] {
  const trimmed = effort?.trim()
  if (!trimmed) return argv
  const v: VendorId = vendor ?? "claude"
  const levels = engineEntry(v).effortLevels
  if (!levels?.includes(trimmed)) return argv
  if (v === "codex") return [...argv, "-c", `model_reasoning_effort=${trimmed}`]
  return argv
}

const CLAUDE_SESSION_CONTROL_FLAGS = new Set(["--session-id", "--resume", "-r", "--continue", "-c", "--from-pr"])

export function withClaudeSessionId(
  argv: readonly string[],
  vendor: string | undefined,
): { argv: readonly string[]; sessionId: string | null } {
  if ((vendor ?? "claude") !== "claude") return { argv, sessionId: null }
  if (argv.some((a) => CLAUDE_SESSION_CONTROL_FLAGS.has(a))) return { argv, sessionId: null }
  const sessionId = randomUUID()
  return { argv: [...argv, "--session-id", sessionId], sessionId }
}

export function kobeApiInvocation(): string {
  const quote = (a: string): string => (/^[A-Za-z0-9_/.:=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)
  try {
    return [...kobeCliInvocation(), "api"].map(quote).join(" ")
  } catch {
    return "kobe api"
  }
}

export function statusReportProtocol(taskId: string, api: string = kobeApiInvocation()): string {
  return [
    `You are running inside kobe (a local multi-session task manager) as task ${taskId}.`,
    "kobe tracks a lifecycle status for this task on a board.",
    "When you have COMPLETED the work requested in this session and verified it, report it by running:",
    `  ${api} set-status --task-id ${taskId} --status in_review`,
    "Run it only when the work is genuinely done — never while you are asking the user a question, waiting for input, or mid-task.",
    "Never set any other status value; everything beyond in_review is the user's decision.",
  ].join("\n")
}

export function noteFilingProtocol(taskId: string, api: string = kobeApiInvocation()): string {
  return [
    "kobe shares hard-won discoveries between its parallel sessions as one-line field notes.",
    "When you RESOLVE a non-obvious, repo-level gotcha (a build flag, a flaky test, an environment quirk, an API trap), file it:",
    `  ${api} note --task-id ${taskId} --text "<one line: the verified conclusion>"`,
    "File only verified conclusions another session could act on — never progress logs, opinions, or details specific to your own task. A handful per session at most.",
  ].join("\n")
}

export function worktreeProtocol(
  taskId: string,
  api: string = kobeApiInvocation(),
  gates: { status?: () => boolean; notes?: () => boolean } = {},
): string | null {
  const parts: string[] = []
  if ((gates.status ?? autoStatusEnabled)()) parts.push(statusReportProtocol(taskId, api))
  if ((gates.notes ?? dispatcherEnabled)()) parts.push(noteFilingProtocol(taskId, api))
  return parts.length > 0 ? parts.join("\n\n") : null
}

export function withWorktreeProtocol(
  argv: readonly string[],
  vendor: string | undefined,
  taskId: string | undefined,
  gates: { status?: () => boolean; notes?: () => boolean } = {},
): readonly string[] {
  if (!taskId) return argv
  if ((vendor ?? "claude") !== "claude") return argv
  if (argv.includes("--append-system-prompt") || argv.includes("--append-system-prompt-file")) {
    return argv
  }
  const text = worktreeProtocol(taskId, kobeApiInvocation(), gates)
  if (!text) return argv
  return [...argv, "--append-system-prompt", text]
}

export function dispatcherProtocol(taskId: string, api: string = kobeApiInvocation()): string {
  return [
    `You are running inside kobe (a local multi-session task manager) as this repository's DISPATCHER (task ${taskId}, the repo's main session).`,
    "kobe runs multiple worktree task sessions on this repo in parallel. When one of them resolves a non-obvious gotcha, it files a one-line field note; kobe forwards each note to you as a user message prefixed with [KOBE FIELD NOTE].",
    "Your job is routing that knowledge, fully autonomously — never ask the user for permission:",
    `  - See the fleet: \`${api} collect --repo .\` (status, running, change counts per task), or \`--task-ids id1,id2\` for specific tasks.`,
    `  - Relay a note to a task that would benefit: \`${api} dispatch --task-id <id> --prompt "[dispatcher] FYI from <author task>: <note verbatim>"\`.`,
    "  - Relay to the in-flight tasks whose work plausibly touches the same area — and to nobody else. If no task benefits, do nothing.",
    "  - Never relay a note back to its author, never relay the same note to the same task twice, and keep relays verbatim with provenance — no summarizing, no embellishment.",
    "Use ONLY the dispatch verb to message sessions — the `send` verb pastes via tmux and would spawn a DUPLICATE engine for web-hosted sessions. If dispatch fails, report the error in your own session and stop; do not fall back.",
    "Take no action on merge conflicts between tasks — the board's conflict radar is display-only by design, and resolution timing belongs to the humans and the tasks themselves.",
    "Never run git commands inside other tasks' worktrees.",
  ].join("\n")
}

export function withDispatcherProtocol(
  argv: readonly string[],
  vendor: string | undefined,
  taskId: string | undefined,
  enabled: () => boolean = dispatcherEnabled,
): readonly string[] {
  if (!taskId || !enabled()) return argv
  if ((vendor ?? "claude") !== "claude") return argv
  if (argv.includes("--append-system-prompt") || argv.includes("--append-system-prompt-file")) {
    return argv
  }
  return [...argv, "--append-system-prompt", dispatcherProtocol(taskId)]
}
