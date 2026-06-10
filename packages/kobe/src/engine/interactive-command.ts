/**
 * Which interactive engine CLI to launch in a task's tmux pane (KOB-233).
 *
 * The "middle" pane of a task session runs a vendor's *interactive* CLI
 * (the same binary a human would run in a terminal) — not the headless
 * path. The vendor → default-argv mapping itself lives on the engine
 * registry (`registry.ts` `defaultCommand`); this module layers the
 * user's per-vendor override on top. Every launch site (the outer
 * monitor's Handover, the Tasks-pane switch, `new-chattab`) goes
 * through this.
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

import { randomUUID } from "node:crypto"
import { engineEntry } from "@/engine/registry"
import { getPersistedString } from "@/state/repos"
import type { VendorId } from "@/types/task"
import { BUILTIN_VENDORS } from "@/types/vendor"

/**
 * Human label for a vendor (Settings → Engines rows). Sourced from the
 * engine registry's `displayName` — the registry is the one place
 * built-in identity lives; this record stays exported for the settings
 * dialog's existing import.
 */
export const VENDOR_LABEL: Record<VendorId, string> = Object.fromEntries(
  BUILTIN_VENDORS.map((v) => [v, engineEntry(v).displayName]),
) as Record<VendorId, string>

/** state.json key holding a vendor's launch-command override string. */
export function engineCommandKey(vendor: VendorId): string {
  return `engineCommand.${vendor}`
}

/**
 * state.json key holding a vendor's custom DISPLAY-NAME override (KOB-244).
 * Parallel to {@link engineCommandKey}; an empty/unset value means "use the
 * built-in {@link VENDOR_LABEL}", so resetting an engine to default is just
 * clearing both keys — no sentinel value.
 */
export function engineNameKey(vendor: VendorId): string {
  return `engineName.${vendor}`
}

/**
 * Display name for an engine id, resolved cross-process from the shared
 * state.json: the user's custom name override (`engineName.<id>`) when set,
 * else the built-in {@link VENDOR_LABEL}, else the id itself (a custom
 * engine with no name set). Used where the reactive settings kv isn't
 * available — e.g. the quick-task composer's engine chips.
 */
export function engineDisplayName(vendor: VendorId): string {
  const override = getPersistedString(engineNameKey(vendor))?.trim()
  return override || VENDOR_LABEL[vendor] || vendor
}

/**
 * Built-in default launch argv for a vendor (undefined → claude), read
 * from the engine registry. A custom engine id has no built-in default —
 * its command lives in the `engineCommand.<id>` override the user set when
 * adding it, which {@link interactiveEngineCommand} reads first; the
 * registry's custom entry only fires if that override is somehow empty, in
 * which case we run a bare binary named after the id rather than silently
 * launching claude.
 */
export function defaultEngineCommand(vendor: VendorId | undefined): readonly string[] {
  return engineEntry(vendor ?? "claude").defaultCommand
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

/**
 * Claude flags that already pin / fork the conversation's session. If the
 * launch command carries one of these, we must NOT also append our own
 * `--session-id` (claude would reject two, or our id would lose to the
 * resumed one). Covers both long and short forms.
 */
const CLAUDE_SESSION_CONTROL_FLAGS = new Set(["--session-id", "--resume", "-r", "--continue", "-c", "--from-pr"])

/**
 * For a Claude launch, append a kobe-generated `--session-id <uuid>` so the
 * tmux window it runs in can be mapped to its transcript (recorded as the
 * `@kobe_session_id` window option) and auto-named from its first prompt
 * (KOB — per-tab naming). Returns `{ argv, sessionId }` where `sessionId`
 * is the forced UUID, or `null` when not applicable:
 *   - the vendor isn't Claude (Codex/Copilot can't take a caller-set id), or
 *   - the command already controls its session (`--resume`/`--continue`/…).
 * `--session-id` is a documented Claude flag (`<uuid>` required); we leave a
 * non-default custom command that pins its own session untouched.
 */
export function withClaudeSessionId(
  argv: readonly string[],
  vendor: string | undefined,
): { argv: readonly string[]; sessionId: string | null } {
  if ((vendor ?? "claude") !== "claude") return { argv, sessionId: null }
  if (argv.some((a) => CLAUDE_SESSION_CONTROL_FLAGS.has(a))) return { argv, sessionId: null }
  const sessionId = randomUUID()
  return { argv: [...argv, "--session-id", sessionId], sessionId }
}
