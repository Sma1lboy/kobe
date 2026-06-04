/**
 * Claude Code hook adapter (KOB) — the first real {@link EngineHookAdapter}.
 *
 * Writes kobe's hooks into the user's GLOBAL `~/.claude/settings.json`, so a
 * single install makes EVERY Claude Code session report normalized activity
 * events back to kobe via `kobe hook <verb>`. The hook carries no task id; it
 * reports its `cwd` and the daemon maps that to a task by worktree path (see
 * `daemon/cwd-task.ts`). This is the ONLY module that knows Claude Code's hook
 * event names + settings.json shape; everything downstream speaks the neutral
 * vocabulary in `../hook-events`.
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

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { kobeCliInvocation } from "../../cli/invocation.ts"
import { shellQuoteArgv } from "../../tmux/session-layout.ts"
import type { EngineHookAdapter } from "../hook-adapter.ts"
import type { EngineActivityKind } from "../hook-events.ts"

/** Claude Code hook event → normalized kobe verb. The ONE place Claude event
 *  names live. `matcher` narrows which Notification types fire (permission only). */
const EVENT_MAP: ReadonlyArray<{ event: string; matcher?: string; verb: EngineActivityKind }> = [
  { event: "SessionStart", verb: "session-start" },
  { event: "UserPromptSubmit", verb: "turn-start" },
  { event: "Stop", verb: "turn-complete" },
  { event: "StopFailure", verb: "turn-failed" },
  { event: "Notification", matcher: "permission_prompt", verb: "awaiting-input" },
  { event: "SessionEnd", verb: "session-end" },
]

/** The events kobe owns — used to replace only these in a merge. */
export const KOBE_HOOK_EVENTS: readonly string[] = EVENT_MAP.map((e) => e.event)

/** Substrings that identify a kobe activity hook in a shared settings file —
 *  the shell-quoted `hook <verb>` fragment of each command, so the marker
 *  matches kobe's OWN previously-written (quoted) commands exactly. */
const ACTIVITY_MARKERS = EVENT_MAP.map((e) => shellQuoteArgv(["hook", e.verb]))

/** Substring identifying kobe's WorktreeCreate hook in a shared settings file. */
const WORKTREE_SYNC_MARKER = "worktree-created"

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Read a JSON object from `path`, or {} if absent/unparseable/not-an-object. */
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** True if a WorktreeCreate hook group is the one kobe installed (by its command). */
function isKobeWorktreeSyncGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && h.command.includes(WORKTREE_SYNC_MARKER),
  )
}

/** True if a hook group is one of kobe's activity groups (by its `kobe hook <verb>` command). */
function isKobeActivityGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) =>
      isObject(h) && typeof h.command === "string" && ACTIVITY_MARKERS.some((m) => (h.command as string).includes(m)),
  )
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

/** Build the activity hook groups kobe installs, pointing each event at
 *  `kobe hook <verb>` (cwd-based; no task id). `inv` (the kobe CLI argv prefix)
 *  is injectable for tests; defaults to the real {@link kobeCliInvocation}. */
export function buildClaudeHooks(inv: readonly string[] = kobeCliInvocation()): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { event, matcher, verb } of EVENT_MAP) {
    const command = shellQuoteArgv([...inv, "hook", verb])
    const group: Record<string, unknown> = { hooks: [{ type: "command", command }] }
    if (matcher) group.matcher = matcher
    out[event] = [group]
  }
  return out
}

/**
 * Pure merge: add (`install`) or remove kobe's activity hooks in a SHARED
 * settings object, preserving the user's own hooks for those events + every
 * other key. kobe owns only the groups whose command matches an
 * {@link ACTIVITY_MARKERS} substring; they're dropped first so re-install is idempotent
 * and removal is clean.
 */
export function mergeActivityHooks(
  current: Record<string, unknown>,
  install: boolean,
  inv: readonly string[] = kobeCliInvocation(),
): Record<string, unknown> {
  const { hooks: rawHooks, ...restSettings } = current
  const hooks: Record<string, unknown> = isObject(rawHooks) ? { ...rawHooks } : {}
  const built = install ? buildClaudeHooks(inv) : {}
  for (const { event } of EVENT_MAP) {
    const prior = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const kept = prior.filter((g) => !isKobeActivityGroup(g))
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
 * a task (creation-time, no session required). Unlike the removed
 * `WorktreeCreate` provider hook, `PostToolUse` is a pure observer: its presence
 * never changes git/`--worktree` behaviour. `matcher: "Bash"` narrows the fire
 * to Bash tool calls; the handler no-ops fast for any non-worktree command.
 */
export function buildWorktreeWatchHook(inv: readonly string[] = kobeCliInvocation()): Record<string, unknown> {
  const command = shellQuoteArgv([...inv, "hook", WORKTREE_SYNC_MARKER])
  return { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] }
}

/** True if a PostToolUse group is kobe's worktree-watch hook (by its `kobe hook
 *  worktree-created` command). */
function isKobeWorktreeWatchGroup(group: unknown): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false
  return group.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && (h.command as string).includes(WORKTREE_SYNC_MARKER),
  )
}

/**
 * Pure merge: add (`install`) or remove kobe's `PostToolUse` worktree-watch hook
 * in a SHARED settings object, preserving the user's own PostToolUse hooks +
 * every other key. kobe owns only the group whose command matches
 * {@link WORKTREE_SYNC_MARKER}; it's dropped first so re-install is idempotent
 * and removal is clean.
 */
export function mergeWorktreeWatchHook(
  current: Record<string, unknown>,
  install: boolean,
  inv: readonly string[] = kobeCliInvocation(),
): Record<string, unknown> {
  const { hooks: rawHooks, ...restSettings } = current
  const hooks: Record<string, unknown> = isObject(rawHooks) ? { ...rawHooks } : {}
  const key = "PostToolUse"
  const prior = Array.isArray(hooks[key]) ? (hooks[key] as unknown[]) : []
  const kept = prior.filter((g) => !isKobeWorktreeWatchGroup(g))
  if (install) kept.push(...(buildWorktreeWatchHook(inv)[key] as unknown[]))
  if (kept.length > 0) hooks[key] = kept
  else delete hooks[key]
  return Object.keys(hooks).length > 0 ? { ...restSettings, hooks } : { ...restSettings }
}

export class ClaudeHookAdapter implements EngineHookAdapter {
  readonly vendor = "claude" as const

  supportsHooks(): boolean {
    return true
  }

  supportsWorktreeSync(): boolean {
    return true
  }

  async installActivityHooks(settingsFilePath: string): Promise<void> {
    await this.editSettings(settingsFilePath, (cur) => mergeActivityHooks(cur, true))
  }

  async removeActivityHooks(settingsFilePath: string): Promise<void> {
    await this.editSettings(settingsFilePath, (cur) => mergeActivityHooks(cur, false))
  }

  async removeWorktreeSyncHook(settingsFilePath: string): Promise<void> {
    await this.editSettings(settingsFilePath, (cur) => mergeWorktreeSyncHook(cur, null))
  }

  async installWorktreeWatchHook(settingsFilePath: string): Promise<void> {
    await this.editSettings(settingsFilePath, (cur) => mergeWorktreeWatchHook(cur, true))
  }

  async removeWorktreeWatchHook(settingsFilePath: string): Promise<void> {
    await this.editSettings(settingsFilePath, (cur) => mergeWorktreeWatchHook(cur, false))
  }

  /**
   * Read → transform → write a SHARED settings.json, skipping the write when the
   * transform is a no-op. The default-on path calls the installers on every
   * launch; we don't want to churn the user's settings.json mtime (or its VCS
   * status) when the hooks are already exactly in place. Best-effort: a failure
   * to read/parse/write the user's settings must never block a launch.
   */
  private async editSettings(
    settingsFilePath: string,
    transform: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    try {
      const current = await readJsonObject(settingsFilePath)
      const next = transform(current)
      if (JSON.stringify(next) === JSON.stringify(current)) return
      await mkdir(dirname(settingsFilePath), { recursive: true })
      await writeFile(settingsFilePath, `${JSON.stringify(next, null, 2)}\n`)
    } catch {
      /* best-effort — never block launch */
    }
  }
}
