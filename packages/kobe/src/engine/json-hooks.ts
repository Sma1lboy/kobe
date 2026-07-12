/**
 * Shared JSON-hooks merge core (KOB) — the engine-neutral half of the hook
 * adapters.
 *
 * Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`)
 * happen to share the SAME hook file shape:
 *
 *   { "hooks": { "<Event>": [ { "matcher"?: string,
 *                               "hooks": [ { "type": "command", "command": … } ] } ] } }
 *
 * so the install/merge/remove mechanics (tag kobe's own groups, replace only
 * those, preserve the user's hooks + every other key, drop empties) are
 * identical. Only the EVENT→verb table differs per engine. This module owns the
 * mechanics; each adapter passes its own {@link HookEventSpec}[] and keeps the
 * vendor's event-name vocabulary. Pure (no I/O), so it's unit-tested directly.
 */

import { kobeHookInvocation } from "../cli/invocation.ts"
import { quoteShellArgv } from "../lib/shell-command.ts"
import type { EngineActivityKind } from "./hook-events.ts"

/** One engine hook event mapped to a normalized kobe verb. `matcher` narrows
 *  which sub-events fire (e.g. only permission notifications). */
export interface HookEventSpec {
  readonly event: string
  readonly matcher?: string
  readonly verb: EngineActivityKind
}

/** The `PostToolUse` event name + tool matcher both engines use for the
 *  creation-time worktree-watch observer. */
export const WORKTREE_WATCH_EVENT = "PostToolUse"
export const WORKTREE_WATCH_MATCHER = "Bash"
/** Command substring identifying kobe's worktree-watch hook in a settings file. */
export const WORKTREE_WATCH_MARKER = "worktree-created"

export function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** The `'hook' '<verb>'` fragment each kobe activity command is written with —
 *  matches kobe's OWN previously-written (shell-quoted) commands exactly, and is
 *  independent of the CLI invocation prefix. */
function activityMarkers(eventMap: readonly HookEventSpec[]): string[] {
  return eventMap.map((e) => quoteShellArgv(["hook", e.verb]))
}

/** True if a hook group is one of kobe's activity groups (by its `kobe hook
 *  <verb>` command substring). */
function isKobeActivityGroup(group: unknown, markers: readonly string[]): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && markers.some((m) => (h.command as string).includes(m)),
  )
}

/** Build the activity hook groups kobe installs, pointing each event at
 *  `kobe hook <verb>` (cwd-based; no task id). `inv` is injectable for tests. */
export function buildActivityHooks(
  eventMap: readonly HookEventSpec[],
  inv: readonly string[] = kobeHookInvocation(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { event, matcher, verb } of eventMap) {
    const command = quoteShellArgv([...inv, "hook", verb])
    const group: Record<string, unknown> = { hooks: [{ type: "command", command }] }
    if (matcher) group.matcher = matcher
    // Accumulate — one event may carry several matcher-scoped specs (e.g.
    // Notification: permission_prompt + idle_prompt).
    const groups = (out[event] as unknown[] | undefined) ?? []
    groups.push(group)
    out[event] = groups
  }
  return out
}

/**
 * Pure merge: add (`install`) or remove kobe's activity hooks in a SHARED
 * settings object, preserving the user's own hooks for those events + every
 * other key. kobe owns only the groups whose command matches an activity
 * marker; they're dropped first so re-install is idempotent and removal clean.
 */
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

/**
 * Build kobe's worktree-WATCH hook: a global `PostToolUse` observer scoped to
 * the `Bash` tool. After every Bash call, `kobe hook worktree-created` runs and
 * — only when the command was a `git worktree add` — adopts the new worktree as
 * a task. A pure observer (fires AFTER the tool), so its presence never changes
 * git/`--worktree` behaviour.
 */
export function buildWorktreeWatchHook(inv: readonly string[] = kobeHookInvocation()): Record<string, unknown> {
  const command = quoteShellArgv([...inv, "hook", WORKTREE_WATCH_MARKER])
  return { [WORKTREE_WATCH_EVENT]: [{ matcher: WORKTREE_WATCH_MATCHER, hooks: [{ type: "command", command }] }] }
}

/** True if a PostToolUse group is kobe's worktree-watch hook. */
function isKobeWorktreeWatchGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && (h.command as string).includes(WORKTREE_WATCH_MARKER),
  )
}

/**
 * Pure merge: add (`install`) or remove kobe's `PostToolUse` worktree-watch hook
 * in a SHARED settings object, preserving the user's own PostToolUse hooks +
 * every other key. Idempotent + merge-safe (replaces only kobe's group).
 */
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
