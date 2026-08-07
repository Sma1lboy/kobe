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
 * Claude's, so failure/permission verbs still have no clean observer signal):
 *   - `SessionStart`     → session-start
 *   - `UserPromptSubmit` → turn-start
 *   - `Stop`             → turn-complete
 *   - `PostToolUse`(Bash)→ worktree-created (inherited worktree-watch observer)
 * NOT wired: `turn-failed` (Codex has no StopFailure/error event),
 * `awaiting-input` (Codex's only "waiting" event is
 * `PermissionRequest`, an allow/deny DECISION hook — installing kobe's observer
 * on it could interfere with Codex's approval flow, the same provider-hook trap
 * that broke `claude --worktree`, so we leave it alone). The polling fallback
 * still covers those states.
 *
 * Trust model: Codex won't RUN a non-managed command hook until the user trusts
 * it once via `/hooks` (or launches with `--dangerously-bypass-hook-trust`).
 * Normal TUI launches preserve that prompt. The Desktop bridge adds the trust
 * bypass only when the same launch already carries Codex's broader
 * `--dangerously-bypass-approvals-and-sandbox` flag.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import type { EngineSessionRef } from "../hook-adapter.ts"
import type { EngineActivityDetail, EngineActivityKind } from "../hook-events.ts"
import { JsonHookAdapter } from "../json-hook-adapter.ts"
import type { HookEventSpec } from "../json-hooks.ts"

/** Codex hook event → normalized kobe verb. The ONE place Codex event names
 *  live. Only the verbs Codex can deliver without touching a decision hook. */
const EVENT_MAP: readonly HookEventSpec[] = [
  { event: "SessionStart", verb: "session-start" },
  { event: "UserPromptSubmit", verb: "turn-start" },
  { event: "Stop", verb: "turn-complete" },
  { event: "SessionEnd", verb: "session-end" },
  // Lifecycle-only verbs (docs/design/plugin-events.md), verified against the
  // installed Codex hook vocabulary.
  { event: "PreCompact", verb: "pre-compact" },
  { event: "PostCompact", verb: "post-compact" },
  { event: "SubagentStart", verb: "subagent-start" },
  { event: "SubagentStop", verb: "subagent-stop" },
  // Tool family: gated (see JsonHookAdapter.gatedVerbs) + behind Codex's own
  // hook trust prompt. Failures arrive folded into tool_response, so there is
  // no tool-failed row.
  { event: "PreToolUse", verb: "tool-pre" },
  { event: "PostToolUse", verb: "tool-post" },
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

  override sessionFromPayload(payload: Record<string, unknown>): EngineSessionRef | undefined {
    if (typeof payload.session_id !== "string" || !payload.session_id) return undefined
    return {
      sessionId: payload.session_id,
      ...(typeof payload.transcript_path === "string" && payload.transcript_path
        ? { transcriptPath: payload.transcript_path }
        : {}),
    }
  }

  /** Codex spells the tool fields `tool_name`/`tool_response`; compaction
   *  carries the same `trigger` values as Claude. */
  override activityDetailFromPayload(
    kind: EngineActivityKind,
    payload: Record<string, unknown>,
  ): EngineActivityDetail | undefined {
    const turnId = typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : undefined
    if (kind === "tool-pre" || kind === "tool-post") {
      const response = payload.tool_response
      return {
        ...(turnId ? { turnId } : {}),
        tool: {
          ...(typeof payload.tool_name === "string" ? { name: payload.tool_name } : {}),
          ...(typeof payload.tool_use_id === "string" ? { id: payload.tool_use_id } : {}),
          ...(payload.tool_input !== undefined ? { input: hookDetail(payload.tool_input) } : {}),
          ...(kind === "tool-post" && response !== undefined
            ? {
                output: hookDetail(response),
                isError: hookResponseIsError(response),
              }
            : {}),
        },
      }
    }
    if (kind === "pre-compact" || kind === "post-compact") {
      return {
        ...(turnId ? { turnId } : {}),
        compact: {
          trigger: payload.trigger === "manual" ? "manual" : "auto",
        },
      }
    }
    if (kind === "subagent-start" || kind === "subagent-stop") {
      return {
        ...(turnId ? { turnId } : {}),
        subagent: {
          ...(typeof payload.agent_type === "string" ? { type: payload.agent_type } : {}),
          ...(typeof payload.agent_id === "string" ? { id: payload.agent_id } : {}),
          ...(typeof payload.agent_transcript_path === "string"
            ? { transcriptPath: payload.agent_transcript_path }
            : {}),
          ...(typeof payload.last_assistant_message === "string"
            ? { result: hookDetail(payload.last_assistant_message) }
            : {}),
        },
      }
    }
    return turnId ? { turnId } : undefined
  }
}

const HOOK_DETAIL_LIMIT = 50_000

function hookDetail(value: unknown): string {
  let text: string
  if (typeof value === "string") text = value
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length <= HOOK_DETAIL_LIMIT ? text : `${text.slice(0, HOOK_DETAIL_LIMIT)}\n\n… truncated live hook detail`
}

function hookResponseIsError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (response.success === false || response.is_error === true) return true
  const exit =
    response.exit_code ??
    (response.metadata && typeof response.metadata === "object"
      ? (response.metadata as Record<string, unknown>).exit_code
      : undefined)
  return typeof exit === "number" && exit !== 0
}
