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
 * Append the status protocol to a CLAUDE launch argv via
 * `--append-system-prompt` — per-invocation injection scoped exactly to
 * kobe-spawned sessions. Why a flag and not a file: a dropped
 * CLAUDE.local.md would sit untracked in the worktree and permanently
 * dirty it (polluting the board's ± counts), manual `claude` runs in the
 * same worktree must stay untouched, and a system prompt survives context
 * compaction where a first-message blurb may not.
 *
 * Gates, in order: the auto-status switch is on (state.json,
 * `experimental.autoStatus`), there is a task to report, the launch
 * targets claude (other vendors have no equivalent flag yet — their cards
 * move by hand until their adapters grow an injection point), and a custom
 * command that already sets the flag is left alone (the
 * {@link withClaudeSessionId} precedent).
 */
export function withStatusProtocol(
  argv: readonly string[],
  vendor: string | undefined,
  taskId: string | undefined,
  enabled: () => boolean = autoStatusEnabled,
): readonly string[] {
  if (!taskId || !enabled()) return argv
  if ((vendor ?? "claude") !== "claude") return argv
  if (argv.includes("--append-system-prompt") || argv.includes("--append-system-prompt-file")) {
    return argv
  }
  return [...argv, "--append-system-prompt", statusReportProtocol(taskId)]
}

/**
 * The DISPATCHER protocol (docs/design/dispatcher.md) — injected into a
 * repo's MAIN session (the complement of the status protocol's main-task
 * exclusion). The main session sits in the repo root with no board card of
 * its own, which makes it the natural per-repo coordinator seat: the
 * daemon's dispatch feeder addresses conflict-radar digests to it, and
 * this prompt tells it what those messages are and which kobe verbs it may
 * act with. Fully autonomous by design (v1 decision: no approval gate) —
 * its only effectors are read (`kobe api collect`) and message
 * (`kobe api dispatch`), so the blast radius of a bad call is a stray
 * message, never a mutated worktree.
 */
export function dispatcherProtocol(taskId: string, api: string = kobeApiInvocation()): string {
  return [
    `You are running inside kobe (a local multi-session task manager) as this repository's DISPATCHER (task ${taskId}, the repo's main session).`,
    "kobe runs multiple worktree task sessions on this repo in parallel. A daemon-side conflict radar dry-run-merges their branches pairwise.",
    "You will receive radar updates as user messages prefixed with [KOBE CONFLICT RADAR], listing task pairs that truly CONFLICT (or merely overlap) and the files involved.",
    "Your job is to coordinate those sessions, fully autonomously — never ask the user for permission:",
    `  - Inspect the fleet when useful: \`${api} collect --repo .\` (status, running, change counts per task), or \`--task-ids id1,id2\` for specific tasks.`,
    `  - Message a task's live session: \`${api} dispatch --task-id <id> --prompt "<text>"\`. Always prefix relayed text with [dispatcher].`,
    "  - For a true conflict, pick exactly ONE side to yield (prefer the smaller or younger change), then message BOTH sides naming the exact files and the other task: tell the YIELDING session to integrate the other branch directly in its own worktree — `git fetch && git merge <other-branch>` — and resolve the conflict there; tell the other session to hold its scope steady on those files.",
    "  - Resolve between the two branches DIRECTLY. Never propose waiting for main or \"land X into main first\" — merging into main is the human's decision and may be far away. Never tell both sides to merge each other (criss-cross), and never tell a session to rebase onto the other task's still-moving branch — merge, don't rewrite.",
    "  - Act only on NEW or UPGRADED pairs; never message a session twice about the same pair state, and stand down silently on an all-clear.",
    "Use ONLY the dispatch verb to message sessions — the `send` verb pastes via tmux and would spawn a DUPLICATE engine for web-hosted sessions. If dispatch fails, report the error in your own session and stop; do not fall back.",
    "Never run git commands inside other tasks' worktrees — coordination happens by messaging their sessions, not by editing their state.",
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
