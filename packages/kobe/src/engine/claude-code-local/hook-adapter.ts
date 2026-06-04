/**
 * Claude Code hook adapter (KOB) — the first real {@link EngineHookAdapter}.
 *
 * Writes a hooks block into the task worktree's `.claude/settings.local.json`
 * so Claude Code, when it runs there, reports normalized activity events back
 * to kobe via `kobe hook <verb> --task-id <id>`. This is the ONLY module that
 * knows Claude Code's hook event names + settings.json shape; everything
 * downstream speaks the neutral vocabulary in `../hook-events`.
 *
 * Two care-abouts:
 *  - **Don't pollute the task diff.** settings.local.json lives inside the
 *    worktree (Claude reads project settings from cwd), so it would show up as
 *    an untracked change the user reviews. We add it to the repo's
 *    `.git/info/exclude` (local-only, never committed, honoured by git status)
 *    so it stays invisible.
 *  - **Don't clobber user hooks.** We own only the events kobe drives, writing
 *    them into settings.LOCAL.json (kobe-managed, gitignored). A user's own
 *    hooks in settings.json (committed) still merge in via Claude's scope
 *    stack; other events in settings.local.json are preserved.
 */

import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { kobeCliInvocation } from "../../cli/invocation.ts"
import { shellQuoteArgv } from "../../tmux/session-layout.ts"
import type { EngineHookAdapter, HookInstallContext } from "../hook-adapter.ts"
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

/** Build the hooks block kobe installs, pointing each event at `kobe hook <verb>`.
 *  `inv` (the kobe CLI argv prefix) is injectable for tests; defaults to the
 *  real {@link kobeCliInvocation}. */
export function buildClaudeHooks(
  taskId: string,
  inv: readonly string[] = kobeCliInvocation(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { event, matcher, verb } of EVENT_MAP) {
    const command = shellQuoteArgv([...inv, "hook", verb, "--task-id", taskId])
    const group: Record<string, unknown> = { hooks: [{ type: "command", command }] }
    if (matcher) group.matcher = matcher
    out[event] = [group]
  }
  return out
}

/** Replace kobe-owned events in `existing`; preserve every other event. */
export function mergeClaudeHooks(
  existing: Record<string, unknown>,
  kobeHooks: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  for (const event of KOBE_HOOK_EVENTS) merged[event] = kobeHooks[event]
  return merged
}

export class ClaudeHookAdapter implements EngineHookAdapter {
  readonly vendor = "claude" as const

  supportsHooks(): boolean {
    return true
  }

  async installTaskHooks(ctx: HookInstallContext): Promise<void> {
    try {
      const claudeDir = join(ctx.worktreeDir, ".claude")
      const settingsPath = join(claudeDir, "settings.local.json")
      await mkdir(claudeDir, { recursive: true })

      let current: Record<string, unknown> = {}
      try {
        const raw = await readFile(settingsPath, "utf8")
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
      } catch {
        /* absent or unparseable → start fresh */
      }

      const existingHooks =
        current.hooks && typeof current.hooks === "object" && !Array.isArray(current.hooks)
          ? (current.hooks as Record<string, unknown>)
          : {}
      current.hooks = mergeClaudeHooks(existingHooks, buildClaudeHooks(ctx.taskId))
      await writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`)

      await hideFromGit(ctx.worktreeDir, ".claude/settings.local.json")
    } catch {
      // Best-effort: a hook-install failure must never block task launch.
    }
  }
}

/**
 * Add `relPath` to the worktree repo's `.git/info/exclude` so it never shows
 * in `git status` / the task diff and is never committed. Idempotent. Silent
 * on any failure (not in a git repo, git missing, etc.).
 */
async function hideFromGit(worktreeDir: string, relPath: string): Promise<void> {
  try {
    const proc = Bun.spawn(["git", "-C", worktreeDir, "rev-parse", "--git-common-dir"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return
    let commonDir = out.trim()
    if (!commonDir) return
    // `rev-parse` may return a relative path (".git") — resolve against the worktree.
    if (!commonDir.startsWith("/")) commonDir = join(worktreeDir, commonDir)
    const excludePath = join(commonDir, "info", "exclude")
    const existing = existsSync(excludePath) ? await readFile(excludePath, "utf8") : ""
    if (existing.split("\n").some((l) => l.trim() === relPath)) return
    await mkdir(join(commonDir, "info"), { recursive: true })
    await appendFile(excludePath, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${relPath}\n`)
  } catch {
    /* best-effort */
  }
}
