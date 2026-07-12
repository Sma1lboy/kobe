/**
 * Which interactive engine CLI to launch in a task's hosted PTY.
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
 * Per-vendor OVERRIDE: the launch command is configurable in
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
import { kobeCliInvocation } from "@/cli/invocation"
import { engineEntry } from "@/engine/registry"
import { autoStatusEnabled } from "@/state/auto-status"
import { dispatcherEnabled } from "@/state/dispatcher"
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
 * state.json key holding a vendor's custom DISPLAY-NAME override.
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
  return withEngineTerminalTitle(withEngineEffort(base, v, effort), v)
}

/**
 * Apply an engine-owned interactive terminal-title policy. The registry
 * carries the argv because Codex's `-c tui.terminal_title=...` syntax is an
 * adapter concern; launch sites and tab chrome remain vendor-neutral.
 */
export function withEngineTerminalTitle(argv: readonly string[], vendor: VendorId | undefined): readonly string[] {
  const args = engineEntry(vendor ?? "claude").terminalTitle?.launchArgs
  return args && args.length > 0 ? [...argv, ...args] : argv
}

/**
 * Append the vendor-correct reasoning/effort flag when `effort` is set AND
 * valid for the vendor (per the registry's {@link EngineRegistryEntry.effortLevels}).
 * Codex maps it to `-c model_reasoning_effort=<level>`; other vendors have no
 * kobe-driveable flag yet, so an effort on them is silently ignored. An
 * unknown / unsupported level is dropped rather than passed through (a bogus
 * value would make the engine refuse to launch).
 */
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

/**
 * Claude flags that already pin / fork the conversation's session. If the
 * launch command carries one of these, we must NOT also append our own
 * `--session-id` (claude would reject two, or our id would lose to the
 * resumed one). Covers both long and short forms.
 */
const CLAUDE_SESSION_CONTROL_FLAGS = new Set(["--session-id", "--resume", "-r", "--continue", "-c", "--from-pr"])

/**
 * For a Claude launch, append a kobe-generated `--session-id <uuid>` so the
 * hosted session can be mapped to its transcript (recorded as the
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

/**
 * Shell-ready `… api` command prefix for protocol prompts. Packaged builds
 * bake plain `kobe api`; a source checkout bakes the dev invocation
 * (`bun --preload … src/cli/index.ts api`) — the same {@link
 * kobeCliInvocation} every kobe-owned pane uses. Without this, a protocol
 * agent in a dev sandbox resolves `kobe` to whatever STALE global install
 * is on PATH, and any verb newer than that install dies with BAD_VERB
 * (field bug: the dispatcher's `dispatch` verb on kobe@0.7.24).
 */
export function kobeApiInvocation(): string {
  const quote = (a: string): string => (/^[A-Za-z0-9_/.:=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)
  try {
    return [...kobeCliInvocation(), "api"].map(quote).join(" ")
  } catch {
    // import.meta.resolve is unavailable in some hosts (vitest's SSR
    // transform) — bare `kobe api` is the best-effort fallback there.
    return "kobe api"
  }
}

/**
 * The status self-report protocol injected into a session's system prompt
 * (docs/design/web-kanban.md M5): the agent itself reports `in_review` when
 * its work is done — it is the one party that KNOWS whether the turn ended
 * "complete" or "asking the user", information the hook layer cannot carry
 * (Stop fires identically for both). The concrete task id is baked in at
 * spawn time (ids are immutable), so the agent never has to guess which
 * task it is. `api` defaults to the environment-correct CLI invocation —
 * tests pass a literal.
 */
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

/**
 * The note-FILING protocol for worktree (card) sessions (docs/design/
 * dispatcher.md): when a session resolves a non-obvious repo-level gotcha,
 * it files a one-line note that the daemon forwards to the repo's
 * dispatcher for routing. Knowledge flows up; the dispatcher decides who
 * needs it.
 */
export function noteFilingProtocol(taskId: string, api: string = kobeApiInvocation()): string {
  return [
    "kobe shares hard-won discoveries between its parallel sessions as one-line field notes.",
    "When you RESOLVE a non-obvious, repo-level gotcha (a build flag, a flaky test, an environment quirk, an API trap), file it:",
    `  ${api} note --task-id ${taskId} --text "<one line: the verified conclusion>"`,
    "File only verified conclusions another session could act on — never progress logs, opinions, or details specific to your own task. A handful per session at most.",
  ].join("\n")
}

/**
 * Compose the protocols a WORKTREE (board-card) session gets, each behind
 * its own switch: status self-report (`experimental.autoStatus`) and note
 * filing (`experimental.dispatcher`). One composed string because claude
 * takes a single `--append-system-prompt` — two sequential with* wrappers
 * would trip each other's existing-flag guard. `null` = nothing enabled.
 */
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

/**
 * Append the composed worktree protocol to a CLAUDE launch argv via
 * `--append-system-prompt` — per-invocation injection scoped exactly to
 * kobe-spawned sessions. Why a flag and not a file: a dropped
 * CLAUDE.local.md would sit untracked in the worktree and permanently
 * dirty it (polluting the board's ± counts), manual `claude` runs in the
 * same worktree must stay untouched, and a system prompt survives context
 * compaction where a first-message blurb may not.
 *
 * Gates, in order: there is a task to report, the launch targets claude
 * (other vendors have no equivalent flag yet — their cards move by hand
 * until their adapters grow an injection point), a custom command that
 * already sets the flag is left alone (the {@link withClaudeSessionId}
 * precedent), and at least one protocol switch is on.
 */
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

/**
 * The DISPATCHER protocol (docs/design/dispatcher.md) — injected into a
 * repo's MAIN session (the complement of the worktree protocol's main-task
 * exclusion). The main session sits in the repo root with no board card of
 * its own, which makes it the natural per-repo knowledge-routing seat:
 * worktree sessions file field notes, the daemon forwards each note here,
 * and this prompt tells the agent how to relay them. Fully autonomous by
 * design (v1 decision: no approval gate) — its only effectors are read
 * (`kobe api collect`) and message (`kobe api dispatch`), so the blast
 * radius of a bad call is a stray FYI, never a mutated worktree. It takes
 * NO action on merge conflicts: the conflict radar is display-only.
 */
export function dispatcherProtocol(taskId: string, api: string = kobeApiInvocation()): string {
  return [
    `You are running inside kobe (a local multi-session task manager) as this repository's DISPATCHER (task ${taskId}, the repo's main session).`,
    "kobe runs multiple worktree task sessions on this repo in parallel. When one of them resolves a non-obvious gotcha, it files a one-line field note; kobe forwards each note to you as a user message prefixed with [KOBE FIELD NOTE].",
    "Your job is routing that knowledge, fully autonomously — never ask the user for permission:",
    `  - See the fleet: \`${api} collect --repo .\` (status, running, change counts per task), or \`--task-ids id1,id2\` for specific tasks.`,
    `  - Relay a note to a task that would benefit: \`${api} dispatch --task-id <id> --prompt "[dispatcher] FYI from <author task>: <note verbatim>"\`.`,
    "  - Relay to the in-flight tasks whose work plausibly touches the same area — and to nobody else. If no task benefits, do nothing.",
    "  - Never relay a note back to its author, never relay the same note to the same task twice, and keep relays verbatim with provenance — no summarizing, no embellishment.",
    "Use ONLY the dispatch verb to message sessions — it targets an already-hosted session without starting an idle task. If dispatch fails, report the error in your own session and stop; do not fall back to send.",
    "Take no action on merge conflicts between tasks — the board's conflict radar is display-only by design, and resolution timing belongs to the humans and the tasks themselves.",
    "Never run git commands inside other tasks' worktrees.",
  ].join("\n")
}

/**
 * Append the dispatcher protocol to a MAIN session's claude launch argv —
 * the same `--append-system-prompt` mechanics (and rationale) as
 * {@link withStatusProtocol}. Gates: the `experimental.dispatcher` switch
 * is on, the launch is a main session (callers pass `taskId` only for
 * main, mirroring how they pass the status protocol's taskId only for
 * board cards — the two injections are mutually exclusive by construction,
 * so the existing-flag guard below never trips between them), the vendor
 * is claude, and a custom command that already sets the flag wins.
 */
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
