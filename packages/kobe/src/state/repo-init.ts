/**
 * Resolve a repo's per-worktree init script + first prompt.
 *
 * Two sources, resolved PER FIELD with the in-repo files taking priority:
 *
 *   1. In-repo convention files, checked out in the worktree:
 *        <worktree>/.kobe/init.sh         → runs before the engine starts
 *        <worktree>/.kobe/init-prompt.md  → pasted as the engine's first prompt
 *      These are version-controlled, so they're the project's authoritative
 *      setup and WIN when present.
 *   2. Per-user state.json override (`kobe repo set …`) — a fallback default
 *      for a repo that doesn't ship its own `.kobe/` files. Keyed by git
 *      toplevel, so it applies to every worktree of the repo.
 *
 * The init script runs in the worktree cwd, in the SAME shell that execs
 * the engine, so `export`s reach the engine. It runs once per worktree
 * (a marker under `<home>/.kobe/` gates re-runs — see env.ts). The init
 * prompt is delivered only when a session is freshly created, never on
 * re-attach.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
  | { readonly kind: "none" }

const INIT_SCRIPT_REL = join(".kobe", "init.sh")
const INIT_PROMPT_REL = join(".kobe", "init-prompt.md")

function repoFileScript(worktreePath: string): string | undefined {
  // Run the committed file by relative path: cwd is the worktree, so
  // `sh .kobe/init.sh` works even when the file isn't chmod +x.
  return existsSync(join(worktreePath, INIT_SCRIPT_REL)) ? `sh ${INIT_SCRIPT_REL}` : undefined
}

function repoFilePrompt(worktreePath: string): string | undefined {
  const p = join(worktreePath, INIT_PROMPT_REL)
  if (!existsSync(p)) return undefined
  try {
    const text = readFileSync(p, "utf8")
    return text.trim().length > 0 ? text : undefined
  } catch {
    return undefined
  }
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

function firstMessageFor(intent: PromptDeliveryIntent, init: ResolvedRepoInit): FirstEngineMessage | undefined {
  if (intent.kind === "none") return undefined
  if (intent.kind === "explicit") return { source: "explicit", text: intent.prompt }
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
): EngineLaunchInit {
  const init = resolveRepoInit(repoRoot, worktreePath)
  return {
    initScript: init.initScript,
    firstMessage: firstMessageFor(intent, init),
  }
}
