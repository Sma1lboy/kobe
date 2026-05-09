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
  /** Token usage report; emitted at least once per turn (typically at end). */
  | { readonly type: "usage"; readonly input_tokens: number; readonly output_tokens: number }
  /** Session is finished cleanly. No more events will follow. */
  | { readonly type: "done" }
  /** Fatal error. The session is dead after this; no `done` follows. */
  | { readonly type: "error"; readonly message: string }

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
   * Stop a running session.
   *
   * Guarantees: best-effort graceful shutdown (SIGTERM with grace, then
   * SIGKILL for local impls; equivalent for remote). Resolves once the
   * session is no longer running. Idempotent — calling on an
   * already-stopped session is a no-op.
   */
  stop(handle: SessionHandle): Promise<void>
}
