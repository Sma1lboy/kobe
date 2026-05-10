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

/**
 * Optional knobs at spawn time. All fields optional — engine impls supply
 * sensible defaults. New options must be added here, not on a subclass.
 */
export interface SpawnOpts {
  /** Model identifier passed through to the engine (e.g. "opus-4.6"). */
  readonly model?: string
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
 * Kept deliberately small. Tool calls and rich blocks live in `content`
 * as a free-form unknown — kobe's renderers narrow per block type. We
 * don't enumerate Claude Code's full content-block taxonomy here because
 * (a) it changes, and (b) Phase 2 remote backends won't share it.
 *
 * `timestamp` is ISO-8601 to match Claude Code's JSONL on-disk format.
 */
export interface Message {
  readonly role: "user" | "assistant" | "system"
  readonly content: unknown
  readonly timestamp: string
  readonly sessionId: string
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
  /** File mtime in epoch ms — used for sort order ("most recent first"). */
  readonly mtimeMs: number
  /** First user prompt, truncated to ~200 chars by the engine. */
  readonly firstUserMessage: string | null
  /** Total message records in the JSONL (incl. tool/system rows). */
  readonly messageCount: number
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
  readHistory(sessionId: string): Promise<Message[]>

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
