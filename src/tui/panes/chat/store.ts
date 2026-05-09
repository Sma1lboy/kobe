/**
 * Wave 3 Stream G — chat state.
 *
 * **Architectural pivot from the original brief (recorded for future
 * sessions).** The first cut planned to maintain a complex `ChatMessage[]`
 * shadow store with `inFlight` accumulator + tool-call correlation map +
 * `pending` flag separate from `isStreaming`. The coordinator pushed back
 * twice with progressively simpler designs. The final shape — what this
 * file implements — is the simplest one that works:
 *
 *   - **Two arrays** (`past`, `live`), one render path.
 *   - **One boolean** (`isStreaming`) that doubles as the loading flag.
 *   - **No re-read after `done`** — opcode doesn't, and the stream
 *     events ARE what Claude Code is writing to JSONL in parallel.
 *     They're two views of the same write stream, not separate sources.
 *   - **Tool-call correlation at render time**, not in this module.
 *     The renderer scans `live` backward for matching `tool.start`.
 *
 * Why two arrays instead of one (the "Option A" of the coordinator's
 * second message): keeping `past: Message[]` (engine-shaped) separate
 * from `live: EngineEvent[]` (event-shaped) is honest about the type
 * drift. The alternative — synthesizing `Message` entries from each
 * `EngineEvent` — requires the synthesizer to stay byte-compatible
 * with whatever JSONL shape Claude Code happens to write. We don't.
 *
 * Lifecycle (the renderer drives this):
 *
 *   1. Task mount / sessionId change:
 *        state = createInitialState()
 *        const past = await engine.readHistory(sessionId)
 *        state = setPast(state, past)
 *   2. Subscribe to orchestrator events.
 *   3. On user submit:
 *        state = pushDraftUser(state, prompt)
 *        await orchestrator.runTask(taskId, prompt)
 *   4. On each EngineEvent:
 *        state = applyEvent(state, ev)
 *        // - assistant.delta / tool.start / tool.result → append to live
 *        // - assistant.delta → isStreaming = true
 *        // - done / error → isStreaming = false (and error sets banner)
 *   5. On task switch: state = createInitialState() (no flush, no merge)
 *
 * Why no re-read on `done`:
 *   - Claude Code writes to JSONL on the same line it emits stream-json.
 *     The events we already appended to `live` are the same content.
 *   - Re-reading would cause a flicker (or a duplicate dance) with no
 *     correctness gain.
 *   - On the NEXT task switch / mount, `readHistory` picks up everything
 *     including the most recent run. So the durability story is intact;
 *     we just don't proactively reconcile mid-session.
 *
 * What's deliberately out of scope:
 *
 *   - Tool-call correlation by id/name. Live events arrive in order;
 *     the renderer pairs them by walking the array. No map.
 *   - `usage` event → token bookkeeping. Future status bar.
 *   - History de-dup against live events on a forced reload. We don't
 *     reload mid-session, so no merge logic exists.
 *
 * No Solid / opentui imports — pure data, vitest-friendly under Node.
 */

import type { EngineEvent, Message } from "../../../types/engine.ts"

/**
 * One ephemeral "user prompt that hasn't been written to JSONL yet"
 * row. Rendered between `past` and `live` so the user sees their own
 * input the moment they hit enter, instead of waiting for Claude Code
 * to flush the user turn to disk. Cleared on the next task switch
 * (which re-reads `past` and the prompt is now part of it).
 *
 * Optional. Some flows (e.g. resume from sidebar with no new prompt)
 * never set it.
 */
export interface DraftUserMessage {
  readonly text: string
  /** Wall-clock submit time, ISO-8601. */
  readonly ts: string
}

/**
 * The chat-pane state. Pure — no Solid signals, no opentui refs.
 */
export interface ChatState {
  /**
   * Persisted history from `engine.readHistory(sessionId)`. Replaced
   * wholesale on task switch. Treated as immutable between
   * {@link setPast} calls — we don't apply live events to it.
   */
  readonly past: readonly Message[]

  /**
   * Events seen since the last task switch / mount. Append-only during
   * a session; cleared on task switch. The renderer maps these to
   * display rows.
   */
  readonly live: readonly EngineEvent[]

  /**
   * The user's just-submitted prompt, rendered eagerly so the user
   * sees their input before the engine flushes it to JSONL. Cleared
   * on task switch (next `past` will include it).
   */
  readonly draftUser: DraftUserMessage | null

  /**
   * True while an assistant turn is in flight. Set on submit (or on
   * the first `assistant.delta` after a session-internal trigger);
   * cleared on `done`/`error`. The {@link Loading} indicator and the
   * trailing streaming-cursor both read this.
   *
   * "Loading" and "streaming" are the same boolean. The visual
   * distinction (spinner vs. cursor) is "is there in-flight assistant
   * text yet?" — derived at render time, not stored here.
   */
  readonly isStreaming: boolean

  /**
   * Transient error banner. Set on engine `error` events or
   * orchestrator `runTask` rejections. Cleared on the next submit.
   */
  readonly error: string | null
}

/** Build the initial state. Used at mount and on task switch. */
export function createInitialState(): ChatState {
  return {
    past: [],
    live: [],
    draftUser: null,
    isStreaming: false,
    error: null,
  }
}

/**
 * Replace persisted history. Called after `engine.readHistory` resolves
 * on task switch / first mount. Clears `live` and `draftUser` because
 * the new `past` is now the full record — anything we'd accumulated in
 * the live buffer is either already in `past` or about to be (if a new
 * stream is starting).
 *
 * Does NOT touch `isStreaming` or `error` — those are independent
 * surfaces.
 */
export function setPast(state: ChatState, past: readonly Message[]): ChatState {
  return {
    ...state,
    past,
    live: [],
    draftUser: null,
  }
}

/**
 * Record a freshly-submitted user prompt. Sets `isStreaming: true`,
 * stamps the draft, clears any prior error. The `runTask` call that
 * the renderer fires next will start producing events that flow
 * through {@link applyEvent}.
 *
 * We set `isStreaming: true` here (not waiting for the first
 * `assistant.delta`) so the loading indicator appears immediately —
 * the user sees feedback the moment they press enter, not 500ms later
 * when the first delta arrives.
 */
export function pushDraftUser(state: ChatState, prompt: string, nowIso: string = new Date().toISOString()): ChatState {
  return {
    ...state,
    isStreaming: true,
    error: null,
    draftUser: { text: prompt, ts: nowIso },
  }
}

/**
 * Apply a single {@link EngineEvent} to the state. Pure — returns a new
 * state, never mutates.
 *
 * Invariants exercised by `test/tui/chat.test.tsx`:
 *
 *   - `assistant.delta`: append to `live`, ensure `isStreaming: true`
 *     (defensive — covers stream-initiated turns where we missed the
 *     `pushDraftUser` call).
 *   - `tool.start` / `tool.result`: append to `live` in arrival order.
 *     The renderer correlates them at draw time.
 *   - `usage`: ignored (status bar's job).
 *   - `done`: set `isStreaming: false`. We do NOT clear `live` —
 *     subsequent mounts/switches re-read from disk and reset; mid-
 *     session, the live record IS the correct trailing render content.
 *   - `error`: set `isStreaming: false`, write the message to `error`.
 *     Like `done`, we keep `live` intact — the user sees the prefix
 *     of the failed turn AND the error banner.
 */
export function applyEvent(state: ChatState, ev: EngineEvent): ChatState {
  switch (ev.type) {
    case "assistant.delta":
      return {
        ...state,
        live: [...state.live, ev],
        isStreaming: true,
      }
    case "tool.start":
    case "tool.result":
      // Tool events stay live for rendering; pairing happens at render
      // time by walking the array. No correlation map here.
      return {
        ...state,
        live: [...state.live, ev],
      }
    case "usage":
      // No-op. Token counts are surfaced in a future status bar pane.
      return state
    case "done":
      return { ...state, isStreaming: false }
    case "error":
      return { ...state, isStreaming: false, error: ev.message }
    default:
      // Exhaustiveness: TS narrows `ev` to `never` here. A new
      // EngineEvent kind that doesn't update `EngineEvent` will crash
      // the build; one that does update the union but doesn't add a
      // case here is silently ignored (defensive — better than
      // crashing the chat).
      return state
  }
}

/**
 * Push a system error from outside the engine event bus (e.g. a
 * `runTask` rejection that never made it to a stream). Sets
 * `isStreaming: false` so the spinner clears.
 */
export function pushSystemError(state: ChatState, message: string): ChatState {
  return {
    ...state,
    isStreaming: false,
    error: message,
  }
}

/** Convenience alias — used at task switch. */
export function reset(): ChatState {
  return createInitialState()
}
