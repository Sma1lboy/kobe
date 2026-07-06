import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getRepoInitOverride } from "./repos.ts"

export interface ResolvedRepoInit {
  readonly initScript?: string
  readonly initPrompt?: string
}

export type FirstEngineMessageSource = "repo-init" | "explicit"

export interface FirstEngineMessage {
  readonly text: string
  readonly source: FirstEngineMessageSource
}

export interface EngineLaunchInit {
  readonly initScript?: string
  readonly firstMessage?: FirstEngineMessage
}

export type PromptDeliveryIntent =
  | { readonly kind: "repo-init" }
  | { readonly kind: "explicit"; readonly prompt: string }
  | { readonly kind: "none" }

const INIT_SCRIPT_REL = join(".kobe", "init.sh")
const INIT_PROMPT_REL = join(".kobe", "init-prompt.md")

function repoFileScript(worktreePath: string): string | undefined {
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
