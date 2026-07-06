import { kobeHookInvocation } from "../cli/invocation.ts"
import { shellQuoteArgv } from "../tmux/session-layout.ts"
import type { EngineActivityKind } from "./hook-events.ts"

export interface HookEventSpec {
  readonly event: string
  readonly matcher?: string
  readonly verb: EngineActivityKind
}

export const WORKTREE_WATCH_EVENT = "PostToolUse"
export const WORKTREE_WATCH_MATCHER = "Bash"
export const WORKTREE_WATCH_MARKER = "worktree-created"

export function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function activityMarkers(eventMap: readonly HookEventSpec[]): string[] {
  return eventMap.map((e) => shellQuoteArgv(["hook", e.verb]))
}

function isKobeActivityGroup(group: unknown, markers: readonly string[]): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && markers.some((m) => (h.command as string).includes(m)),
  )
}

export function buildActivityHooks(
  eventMap: readonly HookEventSpec[],
  inv: readonly string[] = kobeHookInvocation(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { event, matcher, verb } of eventMap) {
    const command = shellQuoteArgv([...inv, "hook", verb])
    const group: Record<string, unknown> = { hooks: [{ type: "command", command }] }
    if (matcher) group.matcher = matcher
    out[event] = [group]
  }
  return out
}

export function mergeActivityHooks(
  current: Record<string, unknown>,
  install: boolean,
  eventMap: readonly HookEventSpec[],
  inv: readonly string[] = kobeHookInvocation(),
): Record<string, unknown> {
  const markers = activityMarkers(eventMap)
  const { hooks: rawHooks, ...restSettings } = current
  const hooks: Record<string, unknown> = isObject(rawHooks) ? { ...rawHooks } : {}
  const built = install ? buildActivityHooks(eventMap, inv) : {}
  for (const { event } of eventMap) {
    const prior = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const kept = prior.filter((g) => !isKobeActivityGroup(g, markers))
    if (install && Array.isArray(built[event])) kept.push(...(built[event] as unknown[]))
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  return Object.keys(hooks).length > 0 ? { ...restSettings, hooks } : { ...restSettings }
}

export function buildWorktreeWatchHook(inv: readonly string[] = kobeHookInvocation()): Record<string, unknown> {
  const command = shellQuoteArgv([...inv, "hook", WORKTREE_WATCH_MARKER])
  return { [WORKTREE_WATCH_EVENT]: [{ matcher: WORKTREE_WATCH_MATCHER, hooks: [{ type: "command", command }] }] }
}

function isKobeWorktreeWatchGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && (h.command as string).includes(WORKTREE_WATCH_MARKER),
  )
}

export function mergeWorktreeWatchHook(
  current: Record<string, unknown>,
  install: boolean,
  inv: readonly string[] = kobeHookInvocation(),
): Record<string, unknown> {
  const { hooks: rawHooks, ...restSettings } = current
  const hooks: Record<string, unknown> = isObject(rawHooks) ? { ...rawHooks } : {}
  const key = WORKTREE_WATCH_EVENT
  const prior = Array.isArray(hooks[key]) ? (hooks[key] as unknown[]) : []
  const kept = prior.filter((g) => !isKobeWorktreeWatchGroup(g))
  if (install) kept.push(...(buildWorktreeWatchHook(inv)[key] as unknown[]))
  if (kept.length > 0) hooks[key] = kept
  else delete hooks[key]
  return Object.keys(hooks).length > 0 ? { ...restSettings, hooks } : { ...restSettings }
}
