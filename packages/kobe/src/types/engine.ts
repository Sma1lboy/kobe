/**
 * Engine-derived data types (v0.6).
 *
 * v0.5 had a full `AIEngine` port (spawn/resume/stream/...) that the
 * orchestrator drove. In v0.6 kobe doesn't drive claude/codex as a
 * subprocess — those run interactively inside a tmux pane and own
 * their own session lifecycle. The only thing kobe still consumes
 * from the engine side is **history on disk**, used by the outer
 * monitor view (live preview rail, cost dashboard, retrospective).
 *
 * What lives here now:
 *   - `Message` / `EngineHistory` / `EngineUsageSnapshot` — the
 *     vendor-neutral shape that `engine/claude-code-local/history.ts`
 *     and `engine/codex-local/history.ts` normalize their on-disk
 *     JSONL into. Renderers downstream consume these, not the raw
 *     vendor records.
 *   - `ContentBlock` re-export — kept here as the canonical engine-type
 *     boundary; the actual taxonomy is owned by `types/content.ts`.
 *
 * What's gone (vs v0.5): `AIEngine`, `EngineEvent`, `SessionHandle`,
 * `SpawnOpts`, all UserInput / ApprovePlan / AskUserQuestion shapes,
 * `OrchestratorEvent`, model / capability / command-discovery surfaces.
 * If a 0.6.x feature needs any of that, restore it deliberately —
 * don't drag the whole port back.
 */

import type { ContentBlock } from "./content"
export type { ContentBlock } from "./content"

/**
 * One historical message read off disk by an engine adapter's history
 * module. `blocks` is the vendor-neutral discriminated union (see
 * `types/content.ts`); adapters normalize their native shape into it
 * before surfacing. `timestamp` is ISO-8601 to match Claude Code's
 * JSONL on-disk format.
 */
export interface Message {
  readonly role: "user" | "assistant" | "system"
  readonly blocks: readonly ContentBlock[]
  readonly timestamp: string
  readonly sessionId: string
  /**
   * Anthropic token usage for this assistant turn, when persisted on
   * disk. Claude Code stores it inline on each assistant record's
   * `message.usage`. Surfaced so the monitor's cost dashboard can
   * aggregate without re-parsing the raw JSONL.
   */
  readonly usage?: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly cache_read_input_tokens?: number
    readonly cache_creation_input_tokens?: number
  }
}

/**
 * Per-turn usage snapshot — what an adapter's history module surfaces
 * alongside the message list. Fields are vendor-neutral; not all
 * adapters fill every field.
 */
export type EngineUsageSnapshot = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
  /** Tokens currently in the session's context window, when known. */
  readonly context_tokens?: number
  /** True when `context_tokens` is kobe-estimated rather than engine-reported. */
  readonly context_tokens_approximate?: boolean
  /** Model context window, when known. */
  readonly context_window_tokens?: number
  /** Tokens/sec across the whole session, when derivable. */
  readonly total_speed_tokens_per_second?: number
}

/**
 * What `engine/<vendor>/history.ts` returns: the full message list plus
 * an aggregate usage snapshot for the session.
 */
export interface EngineHistory {
  readonly messages: readonly Message[]
  readonly usageMetrics?: EngineUsageSnapshot
}
