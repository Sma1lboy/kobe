/**
 * AI Engine port — the single pluggability seam between kobe's orchestrator
 * and the thing that actually runs Claude Code (or, in Phase 2, a remote
 * Conductor backend).
 *
 * See DESIGN.md §5.2 ("The AI Engine Port") and §6 ("Pluggability").
 *
 * The orchestrator must NEVER reach past this interface — no PIDs, no
 * subprocess refs, no raw stream-json shapes. Anything the orchestrator
 * needs must surface through {@link AIEngine} or {@link EngineEvent}.
 */

import type { ContentBlock } from "./content"
import type { VendorId } from "./vendor"
export type { ContentBlock } from "./content"

/**
 * One model entry surfaced by a vendor adapter.
 *
 * `id` is what the adapter forwards to its CLI / API verbatim (e.g.
 * `claude --model <id>`, `codex -m <id>`). `label`/`hint` are the
 * presentation strings the composer's model picker renders.
 *
 * Lives in this file (not under `tui/`) because the model catalog is
 * vendor-owned — each adapter exports its own `readonly ModelChoice[]`
 * through {@link EngineCapabilities.models}. Putting the type next to
 * `AIEngine` keeps the seam in one place; the TUI just consumes it.
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
 * Vendor-supplied capability surface — the single way kobe's
 * orchestrator and TUI ask "what does this engine know / offer?"
 *
 * Every piece of vendor-specific knowledge (model catalog, where the
 * vendor's settings file lives, what counts as the context window for
 * a given model id, how to format the model label) lives on this
 * object. Callers that need any of that go through
 * {@link AIEngine.capabilities} or the engine registry; no module
 * outside the adapter should hard-code `~/.claude/...`, `[1m]` suffix
 * parsing, or model-id literals.
 *
 * This object is intentionally static-ish — function members are
 * pure (no IO beyond cached settings reads) so callers can invoke them
 * freely from render code.
 */
export interface EngineCapabilities {
  readonly vendorId: VendorId
  /** Human-readable vendor name shown in UI ("Claude Code", "Codex"). */
  readonly label: string
  /** Catalog of models this vendor offers in the composer picker. */
  readonly models: readonly ModelChoice[]
  /** Permission/trust modes this vendor can run through kobe. */
  readonly permissionModes: readonly PermissionModeChoice[]
  /**
   * Resolve the current default model id for this vendor. Implementations
   * read the vendor's settings file (e.g. `~/.claude/settings.json` for
   * claude-code, `~/.codex/config.toml` for codex) and fall back to a
   * hardcoded constant when unset.
   */
  defaultModelId(): string
  /**
   * Max context tokens for a given vendor model id, when the adapter can
   * know it statically. Return 0 when the vendor only exposes the real
   * window at runtime through usage telemetry.
   */
  contextWindowFor(modelId: string): number
}

/**
 * Product identity surfaced by the engine adapter.
 *
 * This is UI-facing but still engine-owned: the chat composer should
 * ask the active engine how it wants to be named ("Claude Code",
 * "Codex", etc.) instead of hard-coding vendor strings in TUI code.
 */
export interface EngineIdentity {
  readonly vendorId: VendorId
  readonly productName: string
  readonly shortName: string
  readonly assistantName: string
  readonly inputPlaceholder: string
}

/**
 * Opaque handle to a live engine session. The orchestrator treats this
 * as a black box; only the engine impl knows what's inside (PID, JSONL
 * path, remote run id, etc.).
 *
 * `sessionId` is the only field the orchestrator may inspect — it's the
 * stable identifier we persist on the {@link Task} so a session can be
 * resumed across kobe restarts. For Claude Code, this is the Claude Code
 * session UUID extracted from the `system.init` stream-json message.
 */
export interface SessionHandle {
  /** Stable session identifier. For Claude Code, the session UUID. */
  readonly sessionId: string
  /** Working directory the session was spawned in (typically a worktree). */
  readonly cwd: string
}

/**
 * Tool-permission mode for a session, kobe-side. Only two values:
 * `default` and `plan`. shift+tab in the chat composer toggles between
 * them. `default` is the trusted-bypass mode — the engine maps it to
 * claude-code's `bypassPermissions` when spawning, since `claude -p`
 * has no interactive permission protocol and `acceptEdits` is moot in
 * non-interactive mode (the only meaningful CLI choice is "auto-deny
 * outside cwd" or "auto-approve everything"). `plan` forwards to
 * claude unchanged.
 */
export type PermissionMode = "default" | "plan"

export interface PermissionModeChoice {
  readonly id: PermissionMode
  readonly label: string
}

/**
 * Optional knobs at spawn time. All fields optional — engine impls supply
 * sensible defaults. New options must be added here, not on a subclass.
 */
export interface SpawnOpts {
  /** Model identifier passed through to the engine (e.g. "opus-4.6"). */
  readonly model?: string
  /** Optional model-bound effort/reasoning level. */
  readonly modelEffort?: ModelEffortLevel
  /** Extra environment variables merged into the child process env. */
  readonly env?: Readonly<Record<string, string>>
  /** Hard timeout in milliseconds; engine should kill on overrun. */
  readonly timeoutMs?: number
  /** Optional system prompt prepended to the user prompt. */
  readonly systemPrompt?: string
  /**
   * Tool-permission mode. When omitted the engine omits the flag and the
   * CLI defaults to `default`. See {@link PermissionMode} for the cycle.
   */
  readonly permissionMode?: PermissionMode
  /**
   * Working directory for {@link AIEngine.resume} calls.
   *
   * Only meaningful on `resume()` — `spawn()` takes `cwd` as a positional
   * parameter, so passing it here on spawn is ignored. On resume, this is
   * the absolute path of the worktree the session was originally spawned
   * in. The orchestrator owns it (it knows each {@link Task}'s
   * `worktreePath`), and engines MUST honour it: running a resume in a
   * different cwd than the original spawn lands edits in the wrong
   * worktree and is a regression-class bug covered by behavior tests.
   *
   * Historical note: before this field existed, the orchestrator passed
   * the worktree path via `opts.env.KOBE_RESUME_CWD` as an untyped
   * back-channel. Engines may still read that env var as a defensive
   * fallback for one release, but new callers should use this typed
   * field. See `docs/design/tasks.md` §6.
   */
  readonly cwd?: string
}

/**
 * One historical message read off disk via {@link AIEngine.readHistory}.
 *
 * `blocks` is a vendor-neutral discriminated union — engine adapters
 * normalize their native shape (Claude Code's content-block array) into
 * {@link ContentBlock} before surfacing. See `types/content.ts` for the
 * taxonomy and `engine/claude-code-local/normalize.ts` for the Claude
 * mapping. Renderers downstream consume `blocks` (not raw vendor JSON).
 *
 * `timestamp` is ISO-8601 to match Claude Code's JSONL on-disk format.
 */
export interface Message {
  readonly role: "user" | "assistant" | "system"
  readonly blocks: readonly ContentBlock[]
  readonly timestamp: string
  readonly sessionId: string
  /**
   * Anthropic token usage for this assistant turn, when persisted on disk.
   * Claude Code stores it inline on each assistant record's `message.usage`.
   * Surfaced so the chat pane can repopulate the "context used" meter on
   * history hydration (otherwise the meter is blank until the next turn
   * runs and the engine emits a live `usage` EngineEvent).
   */
  readonly usage?: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly cache_read_input_tokens?: number
    readonly cache_creation_input_tokens?: number
  }
}

export type EngineUsageSnapshot = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
  /** Engine-owned "tokens currently in context" value, when surfaced directly. */
  readonly context_tokens?: number
  /** True when `context_tokens` is kobe-estimated rather than engine-reported. */
  readonly context_tokens_approximate?: boolean
  /** Engine-owned model context window, when surfaced directly. */
  readonly context_window_tokens?: number
  readonly total_speed_tokens_per_second?: number
}

export interface EngineHistory {
  readonly messages: readonly Message[]
  readonly usageMetrics?: EngineUsageSnapshot
}

/**
 * Lightweight session summary for the resume-picker UI.
 *
 * One entry per persisted session in a given cwd. Cheap to compute —
 * the engine reads the JSONL's first conversational record for the
 * preview text and stat()s the file for `mtimeMs`. Full message bodies
 * are NOT loaded; the picker shows the preview, then delegates to
 * {@link AIEngine.readHistory} when the user actually selects one.
 *
 * `firstUserMessage` is `null` if the JSONL has no extractable user
 * line (e.g. a session that errored before the first turn).
 */
export interface SessionMeta {
  readonly sessionId: string
  /** Engine adapter that owns this persisted session. Filled by kobe when aggregating across engines. */
  readonly vendor?: VendorId
  /** File mtime in epoch ms — used for sort order ("most recent first"). */
  readonly mtimeMs: number
  /** First user prompt, truncated to ~200 chars by the engine. */
  readonly firstUserMessage: string | null
  /** Total message records in the JSONL (incl. tool/system rows). */
  readonly messageCount: number
}

export type BackgroundAgentStatus = "running" | "blocked" | "completed" | "failed" | "idle" | "unknown"

/**
 * One Claude Code background agent/session as normalized by an engine adapter.
 *
 * This intentionally sits on the engine seam: Claude owns how background
 * agents are indexed and what their lifecycle states mean. Neutral kobe
 * layers only consume this normalized shape and must not scan vendor-owned
 * files directly.
 */
export interface BackgroundAgent {
  /** Stable row id. For Claude Code this is the background job id when present, otherwise the session id. */
  readonly id: string
  readonly sessionId: string
  readonly name: string | null
  readonly status: BackgroundAgentStatus
  /** Raw engine status string, kept for debugging / forward compatibility. */
  readonly sourceStatus: string | null
  readonly cwd: string
  readonly agent: string | null
  readonly jobId: string | null
  readonly pid: number | null
  readonly version: string | null
  readonly startedAtMs: number | null
  readonly updatedAtMs: number | null
}

/**
 * Normalized engine event. This is the wire format between the engine
 * impl and the orchestrator/UI.
 *
 * Discriminated union on `type`. The engine impl is responsible for
 * mapping its native shape (Claude Code's stream-json, or a remote
 * backend's WebSocket frames) onto this set. Anything that doesn't fit
 * one of these cases gets dropped or surfaced as an `error` — kobe does
 * not pass through unknown event shapes.
 *
 * Why these six and not more: each one corresponds to a UI affordance
 * (token streaming, tool-call banners, usage badge, terminal state,
 * error toast). New events here must justify a new UI surface.
 */
export type EngineEvent =
  /** Streaming chunk of assistant text. Concat in arrival order. */
  | { readonly type: "assistant.delta"; readonly text: string }
  /** Streaming chunk of model reasoning / summary text. Empty chunks are ignored by the UI. */
  | { readonly type: "reasoning.delta"; readonly text: string }
  /** A tool call has begun. `input` is the parsed tool args (engine-shaped). */
  | { readonly type: "tool.start"; readonly name: string; readonly input: unknown }
  /** A tool call completed. `output` is the parsed tool result. */
  | { readonly type: "tool.result"; readonly name: string; readonly output: unknown }
  /**
   * Token usage report; emitted at least once per turn (typically on the
   * terminal `result` frame). Optional cache fields mirror Anthropic's API
   * when prompt caching is active — include them in any "context used"
   * tally so the meter matches Claude Code.
   */
  | {
      readonly type: "usage"
      readonly input_tokens: number
      readonly output_tokens: number
      readonly cache_read_input_tokens?: number
      readonly cache_creation_input_tokens?: number
      readonly context_tokens?: number
      readonly context_tokens_approximate?: boolean
      readonly context_window_tokens?: number
      readonly total_speed_tokens_per_second?: number
    }
  /** Session is finished cleanly. No more events will follow. */
  | { readonly type: "done" }
  /** Fatal error. The session is dead after this; no `done` follows. */
  | { readonly type: "error"; readonly message: string }

/**
 * Synthetic event for prompts that kobe code injected on the user's
 * behalf (e.g. the Create-PR button). Engines never emit this — it's
 * synthesized by the orchestrator and broadcast on the same per-task
 * subscriber bus that carries {@link EngineEvent}s, so chat panes can
 * render the injected prompt as a normal user row without the chat
 * having to know which path triggered it.
 *
 * Kept out of {@link EngineEvent} on purpose: engine impls (and any
 * future remote backend) exhaustively switch over the engine-event
 * union, and an "engine event the engine never emits" would force
 * unreachable cases into every impl.
 */
export type UserInjectEvent = {
  readonly type: "user.inject"
  /** The prompt text shown to the user as if they had typed it. */
  readonly text: string
}

/* --------------------------------------------------------------------- */
/*  User-input requests — tools that pause the session for human input    */
/* --------------------------------------------------------------------- */

/**
 * Payload for an `ExitPlanMode` approval request. The model has produced
 * a plan and is asking the user to approve before it starts editing.
 *
 * Shape mirrors the upstream tool's output: see
 * `refs/claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`.
 */
export type ApprovePlanPayload = {
  readonly kind: "approve_plan"
  /** Markdown body of the plan. Always present (read from the tool input). */
  readonly plan: string
  /**
   * Path the tool wrote the plan to, if it reported one. Optional —
   * older versions don't emit a path, and we don't synthesize one.
   */
  readonly filePath: string | null
}

/**
 * One option a user can pick for an `AskUserQuestion`. Mirrors the
 * upstream schema (refs/claude-code/src/tools/AskUserQuestionTool/
 * AskUserQuestionTool.tsx#questionOptionSchema). `description` is
 * required upstream but we tolerate empty strings for resilience.
 */
export type QuestionOption = {
  readonly label: string
  readonly description: string
}

/**
 * One question in an `AskUserQuestion` call. The tool can ask 1-4
 * questions at once; each is rendered as its own card with its own
 * single/multi-select widget.
 */
export type AskQuestionEntry = {
  readonly question: string
  /** Short chip label (≤ ~12 chars). */
  readonly header: string
  /** When true the user can pick any subset; false = exactly one. */
  readonly multiSelect: boolean
  readonly options: ReadonlyArray<QuestionOption>
}

/**
 * Payload for an `AskUserQuestion` request. The model is asking for
 * a multiple-choice answer and is paused until the user submits.
 */
export type AskQuestionPayload = {
  readonly kind: "ask_question"
  readonly questions: ReadonlyArray<AskQuestionEntry>
}

/**
 * Tools that pause the session for user input. Each kind has a
 * matching response type below; the discriminated unions stay in
 * lockstep so the orchestrator's response renderer is exhaustive.
 */
export type UserInputPayload = ApprovePlanPayload | AskQuestionPayload

/**
 * Synthetic event for "the model is paused, the user has to choose
 * something before it can proceed." Engines never emit this — it's
 * synthesized by the orchestrator when a known user-input tool result
 * comes through (currently `ExitPlanMode`, AskUserQuestion next).
 *
 * The chat renders these as a special row with a per-kind interactive
 * widget (Approve/Reject buttons for plan, radio list for questions).
 * The user's response goes back through `Orchestrator.respondToInput`,
 * which sends a synthetic prompt via `--resume` to continue the session.
 */
export type UserInputRequestEvent = {
  readonly type: "user_input.request"
  /**
   * Stable id for the request. Used by `respondToInput` to look up
   * which pending request the answer belongs to. Generated by the
   * orchestrator at request creation time (the engine doesn't know
   * about kobe's request bookkeeping).
   */
  readonly requestId: string
  readonly payload: UserInputPayload
}

/**
 * The user's answer to a {@link UserInputRequestEvent}. Discriminated
 * by `kind` so the orchestrator can format the right synthetic prompt
 * for each tool family.
 */
export type ApprovePlanResponse = {
  readonly kind: "approve_plan"
  readonly approve: boolean
}

/**
 * Answer to an `AskUserQuestion`. The map is `questionText →
 * answerString` where `answerString` is the chosen option's `label`
 * (or comma-separated labels for multi-select). Mirrors the upstream
 * tool's output schema so the synthetic prompt we round-trip back
 * into the model reads naturally.
 */
export type AskQuestionResponse = {
  readonly kind: "ask_question"
  readonly answers: Readonly<Record<string, string>>
}

export type UserInputResponse = ApprovePlanResponse | AskQuestionResponse

/**
 * Synthetic "the user already answered this" event. The orchestrator
 * dispatches this after `respondToInput` so the chat can update the
 * pending row's status without each renderer having to track it
 * locally. Carries the requestId + the response so the renderer can
 * derive the new row state purely.
 */
export type UserInputResolvedEvent = {
  readonly type: "user_input.resolved"
  readonly requestId: string
  readonly response: UserInputResponse
}

/**
 * Synthesized informational note from the orchestrator, surfaced as a
 * dim system row in chat. Used for lifecycle moments the user benefits
 * from seeing — worktree allocated, branch renamed by the auto-namer
 * — without making them look like errors. Engines never emit this.
 */
export type SystemInfoEvent = {
  readonly type: "system.info"
  readonly text: string
}

/**
 * Tells the chat shell to wipe a tab back to its empty state.
 * Fired by `Orchestrator.clearTab` (the `/clear` slash command) after
 * the tab's session id has been dropped server-side, so every attached
 * TUI's reducer resets in lockstep over the multi-attach broadcast.
 */
export type ChatTabClearedEvent = {
  readonly type: "chat.tab.cleared"
}

/**
 * Anything dispatched on the orchestrator's per-task subscriber bus.
 * UI subscribers (chat) consume this wider type; engine impls produce
 * only the {@link EngineEvent} subset.
 */
export type OrchestratorEvent =
  | EngineEvent
  | UserInjectEvent
  | UserInputRequestEvent
  | UserInputResolvedEvent
  | SystemInfoEvent
  | ChatTabClearedEvent

/**
 * The single seam between kobe and "the thing running tasks."
 *
 * Two intended impls in the codebase lifetime:
 *   1. `ClaudeCodeLocal` — Phase 1, subprocess wrapper around the `claude` CLI.
 *   2. `ConductorBackend` — Phase 2, remote orchestrator adapter.
 *
 * The orchestrator code is identical for both. If you ever feel pressure
 * to add a "is this local?" branch in orchestrator code, that's the
 * interface leaking — fix it here, not there.
 */
export interface AIEngine {
  /**
   * UI-facing engine identity. Neutral layers consume this for product
   * names and placeholder copy; vendor adapters own the strings.
   */
  readonly identity: EngineIdentity

  /**
   * Vendor capabilities — model catalog, default-model resolution,
   * context-window math. The orchestrator and TUI must consult this
   * instead of importing vendor-specific helpers (see
   * {@link EngineCapabilities}). The field is intentionally a readonly
   * property, not a method, so consumers can pull it once and treat it
   * as a stable descriptor for the lifetime of the engine instance.
   */
  readonly capabilities: EngineCapabilities

  /**
   * Start a fresh session in `cwd` with the given prompt.
   *
   * Guarantees: returns once the session is registered (i.e. session id
   * known) but does NOT wait for the session to finish. The caller must
   * pump {@link stream} to drive it to completion.
   */
  spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle>

  /**
   * Resume an existing session by id, sending a follow-up prompt.
   *
   * Guarantees: same as {@link spawn} but on an existing session id. The
   * returned handle's `sessionId` equals the input `sessionId`. The full
   * prior history is preserved by the engine; the caller may but need
   * not re-read it via {@link readHistory}.
   */
  resume(sessionId: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle>

  /**
   * Stream events from a live session.
   *
   * Guarantees: yields events in arrival order; terminates after exactly
   * one terminal event (`done` or `error`). Safe to consume only once
   * per handle — engines may not buffer for late subscribers. If the
   * caller drops the iterator early, the engine continues running; use
   * {@link stop} to actually kill it.
   */
  stream(handle: SessionHandle): AsyncIterable<EngineEvent>

  /**
   * Read historical messages for a session from durable storage.
   *
   * Guarantees: returns all messages persisted at call time, in
   * chronological order. May be called for a session that is currently
   * live, in which case it returns the snapshot up to "now" (no
   * coordination with the live stream — caller dedupes if needed).
   */
  readHistory(sessionId: string): Promise<EngineHistory>

  /**
   * List every session ever persisted for `cwd`, newest first.
   *
   * Used by kobe's resume-picker (chat.session.resume) so the user can
   * pick any prior conversation in the current task's worktree and
   * either jump to it (if already open in a tab) or open it in a new
   * one. The engine is the source of truth here — kobe deliberately
   * does NOT maintain a parallel session index, so a session opened
   * via raw `claude --resume` outside kobe still shows up.
   *
   * Returns `[]` if `cwd` has no persisted sessions. Never throws on
   * I/O — best-effort scan, swallows readdir errors per-entry so a
   * single corrupt JSONL doesn't blank the whole list.
   */
  listSessions(cwd: string): Promise<SessionMeta[]>

  /**
   * List engine-owned background agents started under `cwd`.
   *
   * Claude Code's `claude agents --cwd <path>` is the product reference
   * here. The adapter owns discovery/normalization; callers must not
   * reverse-engineer vendor storage in TUI or orchestrator code.
   * Engines with no background-agent concept return [].
   */
  listBackgroundAgents(cwd: string): Promise<BackgroundAgent[]>

  /**
   * Start an engine-owned background agent under `cwd`.
   *
   * Claude Code owns this lifecycle via `claude --bg <prompt>` and the
   * `claude agents` index. Kobe only forwards the prompt/model/permission
   * choices and consumes the normalized row the adapter can find after
   * launch. Engines with no background-agent concept may return `null`.
   */
  startBackgroundAgent(cwd: string, prompt: string, opts?: SpawnOpts): Promise<BackgroundAgent | null>

  /**
   * Permanently remove the persisted history for a session.
   *
   * Guarantees: best-effort. Removes the on-disk JSONL (or its remote
   * equivalent) and any related metadata. Idempotent — calling on a
   * session with no persisted history is a no-op. Does NOT stop a live
   * session; callers must `stop()` first if they want both.
   */
  deleteHistory(sessionId: string): Promise<void>

  /**
   * Stop a running session.
   *
   * Guarantees: best-effort graceful shutdown (SIGTERM with grace, then
   * SIGKILL for local impls; equivalent for remote). Resolves once the
   * session is no longer running. Idempotent — calling on an
   * already-stopped session is a no-op.
   */
  stop(handle: SessionHandle): Promise<void>
}
