/**
 * Claude Code hook adapter (KOB) — the first real {@link EngineHookAdapter}.
 *
 * Writes kobe's hooks into the user's GLOBAL `~/.claude/settings.json`, so a
 * single install makes EVERY Claude Code session report normalized activity
 * events back to kobe via `kobe hook <verb>`. The hook carries no task id; it
 * reports its `cwd` and the daemon maps that to a task by worktree path (see
 * `daemon/cwd-task.ts`). The read/merge/write I/O and the install/remove
 * methods live in the shared {@link JsonHookAdapter} base; this file adds only
 * what's Claude-specific: the hook event NAMES, the `error_type`/permission
 * detail decoding, and the legacy `WorktreeCreate` cleanup.
 *
 * Why global, not per-worktree: per-task hooks (written into each worktree's
 * `.claude/settings.local.json`) had to be installed at the right moment, only
 * fired after entering a task, didn't reach an already-running engine, and
 * leaked into a project's real repo root. One global block sidesteps all of
 * that and lights up every existing task at once. The cost — kobe's `kobe hook`
 * runs on every Claude session machine-wide — is cheap: it no-ops fast (and
 * never spawns the daemon) when the cwd isn't a kobe task.
 *
 * Don't clobber user hooks: this targets a SHARED file, so each merge tags its
 * own entries (by the kobe command substring) and replaces only those; the
 * user's own hooks for the same events are preserved.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import type { EngineSessionRef } from "../hook-adapter.ts"
import type { EngineActivityDetail, EngineActivityKind } from "../hook-events.ts"
import { JsonHookAdapter, editJsonSettings } from "../json-hook-adapter.ts"
import {
  type HookEventSpec,
  buildActivityHooks,
  buildWorktreeWatchHook,
  isObject,
  mergeActivityHooks as mergeActivityHooksCore,
  mergeWorktreeWatchHook,
} from "../json-hooks.ts"

export { buildWorktreeWatchHook, mergeWorktreeWatchHook }

/** Claude Code hook event → normalized kobe verb. The ONE place Claude event
 *  names live. `matcher` narrows which Notification types fire. */
const EVENT_MAP: readonly HookEventSpec[] = [
  { event: "SessionStart", verb: "session-start" },
  { event: "UserPromptSubmit", verb: "turn-start" },
  { event: "Stop", verb: "turn-complete" },
  { event: "StopFailure", verb: "turn-failed" },
  { event: "Notification", matcher: "permission_prompt", verb: "awaiting-input" },
  // elicitation_dialog = the engine put up a QUESTION dialog (AskUserQuestion /
  // MCP elicitation) — the "question" stage the F7 attention jump must reach.
  // NOT idle_prompt: that fires for ANY prompt idle after a response, which
  // turn_complete already covers and would escalate every idle session.
  { event: "Notification", matcher: "elicitation_dialog", verb: "awaiting-input" },
  { event: "SessionEnd", verb: "session-end" },
]

/** The events kobe owns — used to replace only these in a merge. Deduped:
 *  one event can carry several matcher-scoped specs. */
export const KOBE_HOOK_EVENTS: readonly string[] = [...new Set(EVENT_MAP.map((e) => e.event))]

/** Normalized kobe verb for a Claude Code hook event name, or undefined for an
 *  event kobe doesn't install — the query side of {@link EVENT_MAP}, so tests
 *  (and future callers) can exercise the adapter's install-time translation
 *  without parsing generated hook commands. */
export function claudeVerbForHookEvent(event: string): EngineActivityKind | undefined {
  return EVENT_MAP.find((e) => e.event === event)?.verb
}

/** Map a Claude StopFailure `error_type` to the neutral failure class. Claude
 *  vocabulary (`rate_limit` / `overloaded` / `billing_error` / …) lives here
 *  with the rest of the hook translation, never in `kobe hook`. */
function failureFromErrorType(errorType: unknown): EngineActivityDetail["failure"] {
  if (typeof errorType !== "string") return "other"
  if (errorType === "rate_limit" || errorType === "overloaded") return "rate_limit"
  if (errorType === "billing_error") return "billing"
  return "other"
}

/** Where Claude Code reads user settings (the OS home, NOT kobe's KOBE_HOME_DIR). */
export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json")
}

/** Substring identifying kobe's WorktreeCreate hook in a shared settings file. */
const WORKTREE_SYNC_MARKER = "worktree-created"

/** True if a WorktreeCreate hook group is the one kobe installed (by its command). */
function isKobeWorktreeSyncGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && h.command.includes(WORKTREE_SYNC_MARKER),
  )
}

/** Build kobe's Claude activity hook groups (thin wrapper over the shared core,
 *  bound to Claude's {@link EVENT_MAP}). Exported for tests. */
export function buildClaudeHooks(inv?: readonly string[]): Record<string, unknown> {
  return inv ? buildActivityHooks(EVENT_MAP, inv) : buildActivityHooks(EVENT_MAP)
}

/** Add/remove kobe's Claude activity hooks (thin wrapper over the shared core,
 *  bound to Claude's {@link EVENT_MAP}). Exported for tests. */
export function mergeActivityHooks(
  current: Record<string, unknown>,
  install: boolean,
  inv?: readonly string[],
): Record<string, unknown> {
  return inv
    ? mergeActivityHooksCore(current, install, EVENT_MAP, inv)
    : mergeActivityHooksCore(current, install, EVENT_MAP)
}

/**
 * Pure merge: add (or with `command === null`, remove) kobe's WorktreeCreate
 * hook in a settings object, preserving the user's own hooks + other keys.
 * Drops kobe's prior entry first so re-install is idempotent + removal clean.
 */
export function mergeWorktreeSyncHook(
  current: Record<string, unknown>,
  command: string | null,
): Record<string, unknown> {
  const { hooks: rawHooks, ...restSettings } = current
  const { WorktreeCreate, ...otherHooks } = isObject(rawHooks) ? rawHooks : {}
  const prior = Array.isArray(WorktreeCreate) ? (WorktreeCreate as unknown[]) : []
  const kept = prior.filter((g) => !isKobeWorktreeSyncGroup(g))
  if (command !== null) kept.push({ hooks: [{ type: "command", command }] })
  const nextHooks: Record<string, unknown> = { ...otherHooks }
  if (kept.length > 0) nextHooks.WorktreeCreate = kept
  return Object.keys(nextHooks).length > 0 ? { ...restSettings, hooks: nextHooks } : { ...restSettings }
}

export class ClaudeHookAdapter extends JsonHookAdapter {
  readonly vendor = "claude" as const
  protected readonly eventMap = EVENT_MAP

  globalSettingsPath(): string {
    return claudeSettingsPath()
  }

  /**
   * Fire-time translation: neutral verb + Claude's stdin payload → neutral
   * detail. Only two verbs carry detail today: `turn-failed` (classify the
   * StopFailure `error_type`) and `awaiting-input` (classified by the
   * Notification payload's `notification_type` — `permission_prompt` vs
   * `elicitation_dialog`, the two matchers kobe installs).
   */
  override activityDetailFromPayload(
    kind: EngineActivityKind,
    payload: Record<string, unknown>,
  ): EngineActivityDetail | undefined {
    if (kind === "turn-failed") return { failure: failureFromErrorType(payload.error_type) }
    if (kind === "awaiting-input") {
      return { waiting: payload.notification_type === "elicitation_dialog" ? "input" : "permission" }
    }
    return undefined
  }

  /** Claude pipes `session_id` + `transcript_path` on every hook payload —
   *  the live session identity for whatever fired the hook, INCLUDING
   *  user-typed `claude` sessions kobe never spawned. */
  override sessionFromPayload(payload: Record<string, unknown>): EngineSessionRef | undefined {
    if (typeof payload.session_id !== "string" || !payload.session_id) return undefined
    return {
      sessionId: payload.session_id,
      ...(typeof payload.transcript_path === "string" && payload.transcript_path
        ? { transcriptPath: payload.transcript_path }
        : {}),
    }
  }

  /** Claude is the only engine that ever wrote the legacy `WorktreeCreate`
   *  provider hook, so it's the only one that cleans it up. */
  override supportsWorktreeSync(): boolean {
    return true
  }

  override async removeWorktreeSyncHook(settingsFilePath: string): Promise<void> {
    await editJsonSettings(settingsFilePath, (cur) => mergeWorktreeSyncHook(cur, null))
  }
}
