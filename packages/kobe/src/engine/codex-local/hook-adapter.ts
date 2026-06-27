/**
 * Codex hook adapter (KOB) — the second real {@link EngineHookAdapter}.
 *
 * Codex's hook system (https://developers.openai.com/codex/hooks) uses the SAME
 * settings-file shape as Claude Code — `{ "hooks": { "<Event>": [ { matcher?,
 * hooks: [{ type: "command", command }] } ] } }` — read from
 * `~/.codex/hooks.json`. So this adapter inherits ALL the install/merge/IO
 * mechanics from {@link JsonHookAdapter} and supplies only three things: its
 * vendor id, its event→verb table, and its settings path.
 *
 * What's wired vs. what isn't (Codex's event vocabulary is narrower than
 * Claude's, so three neutral verbs have no clean Codex signal in v1):
 *   - `SessionStart`     → session-start
 *   - `UserPromptSubmit` → turn-start
 *   - `Stop`             → turn-complete
 *   - `PostToolUse`(Bash)→ worktree-created (inherited worktree-watch observer)
 * NOT wired: `turn-failed` (Codex has no StopFailure/error event), `session-end`
 * (no SessionEnd), `awaiting-input` (Codex's only "waiting" event is
 * `PermissionRequest`, an allow/deny DECISION hook — installing kobe's observer
 * on it could interfere with Codex's approval flow, the same provider-hook trap
 * that broke `claude --worktree`, so we leave it alone). The polling fallback
 * still covers those states.
 *
 * Trust model: Codex won't RUN a non-managed command hook until the user trusts
 * it once via `/hooks` (or launches with `--dangerously-bypass-hook-trust`).
 * kobe writes the definition but never auto-bypasses trust, so codex activity
 * badges light up only after the user approves the hook — by design.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { JsonHookAdapter } from "../json-hook-adapter.ts"
import type { HookEventSpec } from "../json-hooks.ts"

/** Codex hook event → normalized kobe verb. The ONE place Codex event names
 *  live. Only the verbs Codex can deliver without touching a decision hook. */
const EVENT_MAP: readonly HookEventSpec[] = [
  { event: "SessionStart", verb: "session-start" },
  { event: "UserPromptSubmit", verb: "turn-start" },
  { event: "Stop", verb: "turn-complete" },
]

/** The Codex events kobe owns — used to replace only these in a merge. */
export const KOBE_CODEX_HOOK_EVENTS: readonly string[] = EVENT_MAP.map((e) => e.event)

/** Where Codex reads user hook definitions. */
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
