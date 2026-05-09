/**
 * kobe chat state — single chronological `messages` array.
 *
 * **Why one array, not three.** The earlier design split state into
 * `past + live + draftUser` (mirroring the engine's "history vs. live
 * events" split). The split couldn't preserve multi-turn user history:
 * `draftUser` was a single slot, so each new user submit overwrote the
 * previous prompt and the user's earlier turns vanished from the chat
 * unless we forced a JSONL re-read on every `done`. opcode's
 * `claude-code-session` does the right thing — one `messages[]` that
 * grows, user submits append to it, assistant deltas append (or
 * coalesce into the in-flight assistant row), tool events append in
 * arrival order. We follow that.
 *
 * Lifecycle:
 *
 *   1. Task mount / sessionId change:
 *        state = createInitialState()
 *        const past = await engine.readHistory(sessionId)
 *        state = setMessagesFromHistory(state, past)
 *   2. Subscribe to orchestrator events.
 *   3. On user submit:
 *        state = pushUser(state, prompt)
 *        await orchestrator.runTask(taskId, prompt)
 *   4. On each EngineEvent:
 *        state = applyEvent(state, ev)
 *   5. On task switch: state = createInitialState() (no flush, no merge).
 *
 * No re-read on `done`. Live events ARE the canonical record while the
 * session is open; the next mount picks up everything from JSONL.
 *
 * No Solid / opentui imports — pure data, vitest-friendly under Node.
 */

import type { EngineEvent, Message, OrchestratorEvent } from "../../../types/engine.ts"

/** One chronological row in the chat. The renderer maps these to JSX. */
export type ChatRow =
  | { readonly kind: "user"; readonly text: string; readonly ts: string }
  | { readonly kind: "assistant"; readonly text: string; readonly ts: string }
  | {
      readonly kind: "tool"
      readonly name: string
      readonly input: unknown
      readonly output?: unknown
      readonly done: boolean
      readonly ts: string
    }
  | { readonly kind: "system"; readonly text: string; readonly ts: string }

export interface ChatState {
  /** All messages in chronological order. Render in array order. */
  readonly messages: readonly ChatRow[]
  /** True between user submit and `done`/`error`. Drives the spinner + cursor. */
  readonly isStreaming: boolean
  /** Transient error banner. Cleared on next submit. */
  readonly error: string | null
}

/** Build the initial state. Used at mount and on task switch. */
export function createInitialState(): ChatState {
  return {
    messages: [],
    isStreaming: false,
    error: null,
  }
}

/**
 * Replace messages from `engine.readHistory(sessionId)`. Called once
 * per task mount. Clears nothing else (history load is independent of
 * streaming state — typically nothing's streaming at mount anyway).
 */
export function setMessagesFromHistory(state: ChatState, past: readonly Message[]): ChatState {
  return {
    ...state,
    messages: past.map(messageToRow),
  }
}

/** Append a freshly-submitted user prompt. Sets `isStreaming: true`. */
export function pushUser(state: ChatState, prompt: string, nowIso: string = new Date().toISOString()): ChatState {
  return {
    ...state,
    isStreaming: true,
    error: null,
    messages: [...state.messages, { kind: "user", text: prompt, ts: nowIso }],
  }
}

/**
 * Apply a single {@link OrchestratorEvent} to the state. Pure.
 *
 *   - `assistant.delta`: append a new assistant row, OR concat into the
 *     last assistant row if it's the most recent message (token-level
 *     streaming would benefit from that; Claude Code emits one delta
 *     per turn so this is mostly the "append" case in practice).
 *   - `tool.start`: push a `tool` row with `done: false`.
 *   - `tool.result`: walk back to the most recent unfinished tool row
 *     with the same `name`, set its `output` and `done`. If no match,
 *     push a standalone tool row.
 *   - `usage`: ignored.
 *   - `done`: `isStreaming: false`.
 *   - `error`: append a `system` row + `isStreaming: false` + banner.
 *   - `user.inject`: append a user row with the injected text and set
 *     `isStreaming: true`. Synthesized by the orchestrator for prompt
 *     injections (e.g. the Create-PR button) so the chat shows the
 *     injected prompt the same way it shows a typed user prompt.
 */
export function applyEvent(
  state: ChatState,
  ev: OrchestratorEvent,
  nowIso: string = new Date().toISOString(),
): ChatState {
  switch (ev.type) {
    case "assistant.delta": {
      const last = state.messages[state.messages.length - 1]
      if (last && last.kind === "assistant") {
        // Concat into the last assistant row (handles token-by-token
        // streaming gracefully if the engine ever switches to that).
        const merged: ChatRow = { kind: "assistant", text: last.text + ev.text, ts: last.ts }
        return {
          ...state,
          isStreaming: true,
          messages: [...state.messages.slice(0, -1), merged],
        }
      }
      return {
        ...state,
        isStreaming: true,
        messages: [...state.messages, { kind: "assistant", text: ev.text, ts: nowIso }],
      }
    }
    case "tool.start":
      return {
        ...state,
        messages: [...state.messages, { kind: "tool", name: ev.name, input: ev.input, done: false, ts: nowIso }],
      }
    case "tool.result": {
      // Find the most recent unfinished tool row with this name and
      // patch it. If none, append a standalone result row.
      const idx = findLastIndex(state.messages, (m) => m.kind === "tool" && !m.done && m.name === ev.name)
      if (idx >= 0) {
        const target = state.messages[idx] as Extract<ChatRow, { kind: "tool" }>
        const patched: ChatRow = { ...target, output: ev.output, done: true }
        const next = state.messages.slice()
        next[idx] = patched
        return { ...state, messages: next }
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          { kind: "tool", name: ev.name, input: undefined, output: ev.output, done: true, ts: nowIso },
        ],
      }
    }
    case "usage":
      return state
    case "done":
      return { ...state, isStreaming: false }
    case "error":
      return {
        ...state,
        isStreaming: false,
        error: ev.message,
        messages: [...state.messages, { kind: "system", text: `error: ${ev.message}`, ts: nowIso }],
      }
    case "user.inject":
      return {
        ...state,
        isStreaming: true,
        error: null,
        messages: [...state.messages, { kind: "user", text: ev.text, ts: nowIso }],
      }
    default:
      return state
  }
}

/**
 * Push a system error from outside the engine event bus (e.g. a
 * `runTask` rejection). Adds a system row + clears streaming.
 */
export function pushSystemError(
  state: ChatState,
  message: string,
  nowIso: string = new Date().toISOString(),
): ChatState {
  return {
    ...state,
    isStreaming: false,
    error: message,
    messages: [...state.messages, { kind: "system", text: `runTask failed: ${message}`, ts: nowIso }],
  }
}

/** Convenience alias — used at task switch. */
export function reset(): ChatState {
  return createInitialState()
}

/* --------------------------------------------------------------------- */
/*  Helpers                                                               */
/* --------------------------------------------------------------------- */

/**
 * Convert a Claude-Code-shape `Message` (from `engine.readHistory`) to
 * a render-friendly `ChatRow`. We coerce the `unknown` content into a
 * string for display; tool blocks inside historical content are not
 * rendered as separate `tool` rows in v1 (they re-appear as live tool
 * events on resume runs).
 */
function messageToRow(m: Message): ChatRow {
  const text = coerceContent(m.content)
  if (m.role === "user") return { kind: "user", text, ts: m.timestamp }
  if (m.role === "assistant") return { kind: "assistant", text, ts: m.timestamp }
  // role === "system"
  return { kind: "system", text, ts: m.timestamp }
}

/**
 * Best-effort string coercion of a Message's `content`. Claude Code's
 * JSONL stores it as either a string or a `[{type, text|...}]` block
 * array. We extract `text` blocks and concat; everything else is
 * dropped (tool blocks, thinking blocks).
 */
function coerceContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block)
        continue
      }
      if (block && typeof block === "object" && "text" in block) {
        const t = (block as { text: unknown }).text
        if (typeof t === "string") parts.push(t)
      }
    }
    return parts.join("")
  }
  return ""
}

/** ES2023 `findLastIndex` polyfill (some target envs don't have it). */
function findLastIndex<T>(arr: readonly T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]
    if (v !== undefined && pred(v)) return i
  }
  return -1
}
