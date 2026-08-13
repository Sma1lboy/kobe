/**
 * Resolve a repo's per-worktree init script + first prompt.
 *
 * Two sources, resolved PER FIELD with the in-repo files taking priority:
 *
 *   1. In-repo convention files, checked out in the worktree:
 *        <worktree>/.rove/init.sh         → runs before the engine starts
 *        <worktree>/.rove/init-prompt.md  → pasted as the engine's first prompt
 *      The legacy `.kobe/` spellings remain field-by-field fallbacks.
 *      These are version-controlled, so they're the project's authoritative
 *      setup and WIN when present.
 *   2. Per-user state.json override (`rove repo set …`) — a fallback default
 *      for a repo that doesn't ship its own convention files. Keyed by git
 *      toplevel, so it applies to every worktree of the repo.
 *
 * The init script runs in the worktree cwd, in the SAME shell that execs
 * the engine, so `export`s reach the engine. It runs once per worktree
 * (a marker under `<home>/.rove/` gates re-runs — see env.ts). The init
 * prompt is delivered only when a session is freshly created, never on
 * re-attach.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { kobeApiInvocation } from "../engine/interactive-command.ts"
import { getRepoInitOverride } from "./repos.ts"

export interface ResolvedRepoInit {
  /** Shell snippet to run before the engine (or undefined for none). */
  readonly initScript?: string
  /** First prompt to deliver after the engine wakes (or undefined). */
  readonly initPrompt?: string
}

export type FirstEngineMessageSource = "repo-init" | "explicit"

export interface FirstEngineMessage {
  /** Text to paste into the engine composer as the first submitted message. */
  readonly text: string
  /** Why this first message exists; used to keep priority rules explicit. */
  readonly source: FirstEngineMessageSource
}

export interface EngineLaunchInit {
  /** Shell snippet to weave before the engine process on fresh session create. */
  readonly initScript?: string
  /** Optional first message for ensureSession's fresh-create path to deliver. */
  readonly firstMessage?: FirstEngineMessage
}

export type PromptDeliveryIntent =
  | { readonly kind: "repo-init" }
  | { readonly kind: "explicit"; readonly prompt: string }
  /**
   * The FIRST prompt of a freshly created worktree task (`add --prompt`,
   * `fan-out`, quick-fork, work-item/automation starts). Delivered like
   * `explicit`, plus a branch-rename coda — the task's branch is an
   * auto-generated placeholder, and the agent reading this prompt is the one
   * party that knows what the work is actually about. Prompts into EXISTING
   * sessions (`send`, `send --tab new`, dispatch, cross-engine handoff) must
   * stay `explicit` so they never re-append the coda.
   *
   * `spawnerTaskId`: the Rove task whose agent created THIS task, when known.
   * Only the CLI layer may supply it (from its own $KOBE_TASK_ID) — never read
   * env here: the daemon can be auto-spawned from inside an engine tab and
   * would bake that stale id into every future automation task.
   */
  | { readonly kind: "new-task"; readonly prompt: string; readonly spawnerTaskId?: string }
  | { readonly kind: "none" }

/**
 * Coda appended to a new worktree task's first prompt. The concrete task id
 * is baked in at spawn time (ids are immutable) — same convention as the
 * status-report protocol. `api` defaults to the environment-correct CLI
 * invocation; tests pass a literal.
 */
export function newTaskBranchCoda(taskId: string, api: string = kobeApiInvocation(), spawnerTaskId?: string): string {
  const rename = `PS: this task's git branch name is an auto-generated placeholder. Once you understand the work, rename it to a short descriptive name (keep the rove/ prefix): \`${api} set-branch --task-id ${taskId} --branch rove/<descriptive-slug>\``
  if (!spawnerTaskId || spawnerTaskId === taskId) return rename
  // Send-back, not `report`: a stored report only surfaces if the spawner
  // explicitly awaits, which in practice it never does — outcomes silently
  // vanished. `send` lands a full turn in the spawner's chat tab.
  return `${rename}\n\nYou were spawned by Rove task ${spawnerTaskId}. When the work is finished, send your outcome back to it — include the final branch name: \`${api} send --task-id ${spawnerTaskId} --prompt "<succeeded|failed>: <one-line summary> (branch rove/<slug>)"\``
}

const INIT_SCRIPT_RELS = [join(".rove", "init.sh"), join(".kobe", "init.sh")] as const
const INIT_PROMPT_RELS = [join(".rove", "init-prompt.md"), join(".kobe", "init-prompt.md")] as const

function repoFileScript(worktreePath: string): string | undefined {
  // Run the committed file by relative path: cwd is the worktree, so
  // `sh .rove/init.sh` works even when the file isn't chmod +x.
  //
  // The literal, NOT `INIT_SCRIPT_REL`: this string is read by the shell, and
  // Native `join` separators are only for probing; the returned shell path is
  // always POSIX because Git Bash treats a backslash as an escape.
  for (const [relative, command] of [
    [INIT_SCRIPT_RELS[0], "sh .rove/init.sh"],
    [INIT_SCRIPT_RELS[1], "sh .kobe/init.sh"],
  ] as const) {
    if (existsSync(join(worktreePath, relative))) return command
  }
  return undefined
}

function repoFilePrompt(worktreePath: string): string | undefined {
  for (const relative of INIT_PROMPT_RELS) {
    const p = join(worktreePath, relative)
    if (!existsSync(p)) continue
    try {
      const text = readFileSync(p, "utf8")
      if (text.trim().length > 0) return text
    } catch {
      // Try the compatibility file, then the per-user fallback.
    }
  }
  return undefined
}

/**
 * Resolve the effective init script + first prompt for a worktree. Repo
 * files win per field; the state.json override fills the gaps.
 */
export function resolveRepoInit(repoRoot: string, worktreePath: string): ResolvedRepoInit {
  const override = repoRoot ? getRepoInitOverride(repoRoot) : {}
  const initScript = repoFileScript(worktreePath) ?? override.initScript
  const initPrompt = repoFilePrompt(worktreePath) ?? override.initPrompt
  return {
    initScript: initScript && initScript.trim().length > 0 ? initScript : undefined,
    initPrompt: initPrompt && initPrompt.trim().length > 0 ? initPrompt : undefined,
  }
}

function firstMessageFor(
  intent: PromptDeliveryIntent,
  init: ResolvedRepoInit,
  taskId?: string,
): FirstEngineMessage | undefined {
  if (intent.kind === "none") return undefined
  if (intent.kind === "explicit") return { source: "explicit", text: intent.prompt }
  if (intent.kind === "new-task") {
    // `$ROVE_TASK_ID` fallback: exported into every engine tab's env, so the
    // agent's shell expands it even if a caller never threaded the id here.
    return {
      source: "explicit",
      text: `${intent.prompt}\n\n${newTaskBranchCoda(taskId ?? '"$ROVE_TASK_ID"', undefined, intent.spawnerTaskId)}`,
    }
  }
  const text = init.initPrompt?.trim()
  return text ? { source: "repo-init", text } : undefined
}

/**
 * Resolve the complete launch-time prompt contract for a worktree. Callers
 * choose the intent; this module owns the source priority and first-message
 * shape so engine launch paths don't hand-roll initPrompt suppression.
 */
export function resolveEngineLaunchInit(
  repoRoot: string,
  worktreePath: string,
  intent: PromptDeliveryIntent = { kind: "repo-init" },
  taskId?: string,
): EngineLaunchInit {
  const init = resolveRepoInit(repoRoot, worktreePath)
  return {
    initScript: init.initScript,
    firstMessage: firstMessageFor(intent, init, taskId),
  }
}
