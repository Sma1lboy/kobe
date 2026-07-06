import { homedir } from "node:os"
import { join } from "node:path"
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

const EVENT_MAP: readonly HookEventSpec[] = [
  { event: "SessionStart", verb: "session-start" },
  { event: "UserPromptSubmit", verb: "turn-start" },
  { event: "Stop", verb: "turn-complete" },
  { event: "StopFailure", verb: "turn-failed" },
  { event: "Notification", matcher: "permission_prompt", verb: "awaiting-input" },
  { event: "SessionEnd", verb: "session-end" },
]

export const KOBE_HOOK_EVENTS: readonly string[] = EVENT_MAP.map((e) => e.event)

export function claudeVerbForHookEvent(event: string): EngineActivityKind | undefined {
  return EVENT_MAP.find((e) => e.event === event)?.verb
}

function failureFromErrorType(errorType: unknown): EngineActivityDetail["failure"] {
  if (typeof errorType !== "string") return "other"
  if (errorType === "rate_limit" || errorType === "overloaded") return "rate_limit"
  if (errorType === "billing_error") return "billing"
  return "other"
}

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json")
}

const WORKTREE_SYNC_MARKER = "worktree-created"

function isKobeWorktreeSyncGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && h.command.includes(WORKTREE_SYNC_MARKER),
  )
}

export function buildClaudeHooks(inv?: readonly string[]): Record<string, unknown> {
  return inv ? buildActivityHooks(EVENT_MAP, inv) : buildActivityHooks(EVENT_MAP)
}

export function mergeActivityHooks(
  current: Record<string, unknown>,
  install: boolean,
  inv?: readonly string[],
): Record<string, unknown> {
  return inv
    ? mergeActivityHooksCore(current, install, EVENT_MAP, inv)
    : mergeActivityHooksCore(current, install, EVENT_MAP)
}

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

  override activityDetailFromPayload(
    kind: EngineActivityKind,
    payload: Record<string, unknown>,
  ): EngineActivityDetail | undefined {
    if (kind === "turn-failed") return { failure: failureFromErrorType(payload.error_type) }
    if (kind === "awaiting-input") return { waiting: "permission" }
    return undefined
  }

  override supportsWorktreeSync(): boolean {
    return true
  }

  override async removeWorktreeSyncHook(settingsFilePath: string): Promise<void> {
    await editJsonSettings(settingsFilePath, (cur) => mergeWorktreeSyncHook(cur, null))
  }
}
