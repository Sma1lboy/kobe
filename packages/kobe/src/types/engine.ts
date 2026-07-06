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
 * `OrchestratorEvent`, command-discovery surfaces.
 * If a 0.6.x feature needs any of that, restore it deliberately —
 * don't drag the whole port back.
 *
 * Shared engine-capability types: `ModelChoice` / `ModelEffortLevel` /
 * `EngineCapabilities` / `EngineIdentity` / `PermissionMode` — the
 * composer's model picker + permission-mode cycle consume these
 * through the engine registry (engine-owned UI data, CLAUDE.md).
 */

import type { ContentBlock } from "./content"
import type { VendorId } from "./vendor"
export type { ContentBlock } from "./content"

/**
 * One selectable model in the composer's model picker. `id` is what the
 * adapter forwards to its CLI verbatim (`claude --model <id>`).
 * Vendor-owned: each adapter exports its catalog through
 * {@link EngineCapabilities.models}; the TUI just consumes it.
 */
export type ModelChoice = {
  /** Which engine adapter owns this model. */
  readonly vendor: VendorId
  /** Vendor-specific model id passed to the adapter. */
  readonly id: string
  /** Optional model-bound reasoning/effort level passed to the adapter. */
  readonly effort?: ModelEffortLevel
  /** Optional picker grouping label for model-bound levels. */
  readonly level?: string
  /** Short label shown in the composer footer + picker. */
  readonly label: string
  /** Optional one-liner shown next to the label in the picker. */
  readonly hint?: string
}

export type ModelEffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/**
 * Tool-permission mode for a headless chat session. Forwarded verbatim
 * as `--permission-mode`; headless `-p` cannot prompt, so a tool outside
 * the mode's allowance is denied, not asked. shift+tab in the composer
 * cycles through the engine's {@link EngineCapabilities.permissionModes}.
 */
export type PermissionMode = "default" | "acceptEdits" | "plan"

export interface PermissionModeChoice {
  readonly id: PermissionMode
  readonly label: string
}

/**
 * Vendor-supplied capability surface — the single way the TUI asks
 * "what does this engine know / offer?". No module outside the adapter
 * should hard-code `~/.claude/...` paths or model-id literals.
 * Function members are pure (no IO beyond cached settings reads) so
 * callers can invoke them freely from render code.
 */
export interface EngineCapabilities {
  readonly vendorId: VendorId
  /** Human-readable vendor name shown in UI ("Claude Code"). */
  readonly label: string
  /** Catalog of models this vendor offers in the composer picker. */
  readonly models: readonly ModelChoice[]
  /** Permission/trust modes this vendor can run through kobe. */
  readonly permissionModes: readonly PermissionModeChoice[]
  /** Resolve the vendor's current default model id (settings file, then fallback). */
  defaultModelId(): string
  /** Max context tokens for a model id, or 0 when unknown statically. */
  contextWindowFor(modelId: string): number
  /** The vendor's small/fast model id for metadata one-shots, if any. */
  smallFastModelId?(): string | undefined
}

/**
 * Product identity surfaced by the engine adapter — the composer asks
 * the engine how it wants to be named instead of hard-coding vendor
 * strings in TUI code.
 */
export interface EngineIdentity {
  readonly vendorId: VendorId
  readonly productName: string
  readonly shortName: string
  readonly assistantName: string
  readonly inputPlaceholder: string
}

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
