import { homedir } from "node:os"
import { join } from "node:path"
import { JsonHookAdapter } from "../json-hook-adapter.ts"
import type { HookEventSpec } from "../json-hooks.ts"

const EVENT_MAP: readonly HookEventSpec[] = [
  { event: "SessionStart", verb: "session-start" },
  { event: "UserPromptSubmit", verb: "turn-start" },
  { event: "Stop", verb: "turn-complete" },
]

export const KOBE_CODEX_HOOK_EVENTS: readonly string[] = EVENT_MAP.map((e) => e.event)

export function codexHooksPath(): string {
  return join(homedir(), ".codex", "hooks.json")
}

export class CodexHookAdapter extends JsonHookAdapter {
  readonly vendor = "codex" as const
  protected readonly eventMap = EVENT_MAP

  globalSettingsPath(): string {
    return codexHooksPath()
  }
}
