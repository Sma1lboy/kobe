/**
 * Which interactive engine CLI to launch in a task's tmux pane (KOB-233).
 *
 * The "middle" pane of a task session runs a vendor's *interactive* CLI
 * (the same binary a human would run in a terminal) — not the headless
 * path. This is the single place that maps a task's `vendor` to that
 * argv, so wiring a new engine (gemini, copilot, …) is a one-line case
 * here plus its history reader; every launch site (the outer monitor's
 * Handover, the Tasks-pane switch, `new-chattab`) goes through this.
 *
 * Codex's bare `codex` (no subcommand) opens its interactive TUI, the
 * same way bare `claude` does — `codex exec` is the headless path we
 * deliberately don't use here.
 *
 * Per-vendor OVERRIDE (KOB-244): the launch command is configurable in
 * Settings → Engines, so a user whose binary isn't on PATH as `claude`
 * (e.g. it's `cl`) or who wants default flags (`claude --model …`) can
 * set their own. The override is a shell-ish command STRING persisted in
 * the shared `state.json` under {@link engineCommandKey}; we read it with
 * the cross-process {@link getPersistedString} (the Tasks-pane and
 * `new-chattab` run in their own processes, so they can't share the TUI's
 * reactive KV — they all read the same file instead). Empty / unset →
 * the built-in default.
 */

import { getPersistedString } from "@/state/repos"
import type { VendorId } from "@/types/task"

/** Built-in launch argv per vendor, before any user override. */
const DEFAULT_COMMANDS: Record<VendorId, readonly string[]> = {
  claude: ["claude"],
  codex: ["codex"],
}

/** Human label for a vendor (Settings → Engines rows). */
export const VENDOR_LABEL: Record<VendorId, string> = {
  claude: "Claude",
  codex: "Codex",
}

/** state.json key holding a vendor's launch-command override string. */
export function engineCommandKey(vendor: VendorId): string {
  return `engineCommand.${vendor}`
}

/** Built-in default launch argv for a vendor (undefined → claude). */
export function defaultEngineCommand(vendor: VendorId | undefined): readonly string[] {
  return DEFAULT_COMMANDS[vendor ?? "claude"] ?? DEFAULT_COMMANDS.claude
}

/**
 * Split a command string into argv, honouring single/double quotes so a
 * flag value with a space survives (`claude --append-system-prompt "be
 * terse"`). Whitespace-separated otherwise. Returns `[]` for blank input.
 */
export function parseEngineCommand(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(command); m !== null; m = re.exec(command)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "")
  }
  return out
}

export function interactiveEngineCommand(vendor: VendorId | undefined): readonly string[] {
  const v: VendorId = vendor ?? "claude"
  const override = getPersistedString(engineCommandKey(v))?.trim()
  if (override) {
    const argv = parseEngineCommand(override)
    if (argv.length > 0) return argv
  }
  return defaultEngineCommand(v)
}
