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
 *   5. On task switch: state for the outgoing task's tabs is left in
 *      place — `statesByTab` is module-scoped in useChatSession, so
 *      returning to a tab brings its queue / messages back without
 *      a fresh `createInitialState()` (KOB-61). Only the event
 *      subscriptions are torn down + re-attached.
 *
 * No re-read on `done`. Live events ARE the canonical record while the
 * session is open; the next mount picks up everything from JSONL.
 *
 * No Solid / opentui imports — pure data, vitest-friendly under Node.
 */

import type { SessionUsageMetrics } from "../../../session/usage-metrics.ts"
import type { EngineEvent, Message, OrchestratorEvent } from "../../../types/engine.ts"
import { cleanChatText } from "./noise-filter.ts"
import type { ChatRow, ChatState } from "./row-types.ts"
import { capMessages } from "./scrollback.ts"

export { cleanChatText } from "./noise-filter.ts"
export type { ChatRow, ChatState } from "./row-types.ts"

export { SCROLLBACK_CAP } from "./scrollback.ts"
export {
  drainPendingBashContext,
  formatBashContextPrefix,
  patchBashRow,
  pushBashRow,
  pushPendingBashContext,
} from "./bash-state.ts"
export type { PendingBashContext } from "./bash-state.ts"
export {
  QUEUE_SOFT_CAP,
  clearQueue,
  dequeueFirst,
  enqueueBashCommand,
  enqueuePrompt,
  queueIsFull,
  removeFromQueue,
  updateQueueItem,
} from "./queue.ts"

export type { QueuedPrompt } from "./queue.ts"

/** Build the initial state. Used at mount and on task switch. */
export function createInitialState(): ChatState {
  return {
    messages: [],
    isStreaming: false,
    error: null,
    queue: [],
  }
}

/**
 * Replace messages from `engine.readHistory(sessionId)`. Called once
 * per task mount. Clears nothing else (history load is independent of
 * streaming state — typically nothing's streaming at mount anyway).
 *
 * Walks each message's content blocks and produces one or more
 * ChatRows per message:
 *   - `text` block → user/assistant/system row (per role)
 *   - `tool_use` block → tool row with `done: false` + `toolUseId`
 *   - `tool_result` block → patches the matching tool row (by
 *     `tool_use_id`) to `done: true` + `output`; emits NO row of
 *     its own (the tool result lives on the tool row, not as a
 *     standalone user row)
 *   - `thinking` block → reasoning row
 *   - other unrecognised blocks → dropped
 *
 * Messages whose content is purely tool blocks produce no text row
 * (so we don't litter the chat with empty `⏺`/`>` rows for assistant
 * messages that only invoked tools or user messages that only
 * carried tool results).
 */
export function setMessagesFromHistory(
  state: ChatState,
  past: readonly Message[],
  usageMetrics?: SessionUsageMetrics,
): ChatState {
  const rows: ChatRow[] = []
  // tool_use_id → index into `rows`. Used to back-patch when the
  // matching `tool_result` arrives on a later message.
  const toolIndexById = new Map<string, number>()

  for (const m of past) {
    appendRowsFromMessage(rows, toolIndexById, m)
  }

  // Rehydrate the context meter from engine-owned persisted usage.
  const latestUsage = usageMetrics

  // Apply the cap on the hydration path too — don't load 5000
  // historical rows just to drop 4000 immediately on the next delta.
  return {
    ...state,
    messages: capMessages(rows, new Date().toISOString()),
    ...(latestUsage ? { lastUsage: latestUsage } : {}),
  }
}

/** Append a freshly-submitted user prompt. Sets `isStreaming: true`. */
export function pushUser(state: ChatState, prompt: string, nowIso: string = new Date().toISOString()): ChatState {
  return {
    ...state,
    isStreaming: true,
    error: null,
    lastUsage: undefined,
    activeTurnStartedAt: nowIso,
    messages: capMessages([...state.messages, { kind: "user", text: prompt, ts: nowIso }], nowIso),
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
 *   - `usage`: record {@link ChatState.lastUsage} for the context meter; messages unchanged.
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
    case "reasoning.delta": {
      if (ev.text.length === 0) return state
      const last = state.messages[state.messages.length - 1]
      if (last && last.kind === "reasoning") {
        const merged: ChatRow = { kind: "reasoning", text: last.text + ev.text, ts: last.ts }
        return {
          ...state,
          isStreaming: true,
          messages: [...state.messages.slice(0, -1), merged],
        }
      }
      return {
        ...state,
        isStreaming: true,
        messages: capMessages([...state.messages, { kind: "reasoning", text: ev.text, ts: nowIso }], nowIso),
      }
    }
    case "assistant.delta": {
      const last = state.messages[state.messages.length - 1]
      if (last && last.kind === "assistant") {
        // Concat into the last assistant row (handles token-by-token
        // streaming gracefully if the engine ever switches to that).
        // No length change → no truncation needed; the live in-flight
        // row stays at the tail and is preserved.
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
        messages: capMessages([...state.messages, { kind: "assistant", text: ev.text, ts: nowIso }], nowIso),
      }
    }
    case "tool.start":
      return {
        ...state,
        messages: capMessages(
          [...state.messages, { kind: "tool", name: ev.name, input: ev.input, done: false, ts: nowIso }],
          nowIso,
        ),
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
        // In-place patch — no length change, cap not needed.
        return { ...state, messages: next }
      }
      return {
        ...state,
        messages: capMessages(
          [
            ...state.messages,
            { kind: "tool", name: ev.name, input: undefined, output: ev.output, done: true, ts: nowIso },
          ],
          nowIso,
        ),
      }
    }
    case "usage":
      return {
        ...state,
        lastUsage: {
          input_tokens: ev.input_tokens,
          output_tokens: ev.output_tokens,
          cache_read_input_tokens: ev.cache_read_input_tokens,
          cache_creation_input_tokens: ev.cache_creation_input_tokens,
          context_tokens: ev.context_tokens,
          context_tokens_approximate: ev.context_tokens_approximate,
          context_window_tokens: ev.context_window_tokens,
          total_speed_tokens_per_second: ev.total_speed_tokens_per_second,
        },
      }
    case "done":
      return { ...state, isStreaming: false, activeTurnStartedAt: undefined }
    case "error":
      return {
        ...state,
        isStreaming: false,
        activeTurnStartedAt: undefined,
        error: ev.message,
        messages: capMessages(
          [...state.messages, { kind: "system", text: `error: ${ev.message}`, ts: nowIso }],
          nowIso,
        ),
      }
    case "user.inject": {
      // Strip claude-code wrapper tags (e.g. `<bash-input>` from the
      // KOB-83 bash-mode prefix, `<command-name>` from a slash command,
      // `<system-reminder>` from harness injections) so the user row
      // shows only the human-meaningful text. The history-replay path
      // (`appendRowsFromMessage` → `cleanChatText`) already does this;
      // mirror it on the live event path so a freshly-dispatched
      // user.inject doesn't render the raw XML before the next mount.
      const cleaned = cleanChatText(ev.text)
      // Drop the row entirely when stripping leaves nothing — bash mode
      // can fire the bash-context prefix WITHOUT any trailing user text
      // (e.g. follow-up `!cmd` while a prompt is queued). Adding an
      // empty user row would render a bare `>` chip with nothing next
      // to it, matching the same suppression `cleanChatText` applies
      // during history hydration.
      if (cleaned.length === 0) {
        return { ...state, isStreaming: true, error: null, lastUsage: undefined, activeTurnStartedAt: nowIso }
      }
      return {
        ...state,
        isStreaming: true,
        error: null,
        lastUsage: undefined,
        activeTurnStartedAt: nowIso,
        messages: capMessages([...state.messages, { kind: "user", text: cleaned, ts: nowIso }], nowIso),
      }
    }
    case "system.info":
      // Dim status note from the orchestrator (worktree allocated,
      // branch renamed, etc). Renders as a `system` row in muted
      // text — see MessageList's SystemRow / `isError` predicate
      // which only flips to error styling on "error:"/"runTask
      // failed" prefixes, neither of which we use here.
      return {
        ...state,
        messages: capMessages([...state.messages, { kind: "system", text: ev.text, ts: nowIso }], nowIso),
      }
    case "chat.tab.cleared":
      // `/clear` slash command. Wipe the tab back to a freshly-mounted
      // shape — no messages, no streaming flag, no queue, no pending
      // approval, no usage meter. The orchestrator has already dropped
      // the tab's sessionId server-side so the next runTask spawns a
      // new Claude session instead of resuming the old one.
      return createInitialState()
    case "user_input.request": {
      // Subprocess has exited (the tool runs to completion in -p mode
      // and just leaves a marker), so streaming flips off — the
      // approval / question row IS the new "active" UI affordance,
      // not a spinner. Each kind appends a different ChatRow shape.
      if (ev.payload.kind === "approve_plan") {
        return {
          ...state,
          isStreaming: false,
          messages: capMessages(
            [
              ...state.messages,
              {
                kind: "approval",
                requestId: ev.requestId,
                tool: "ExitPlanMode",
                plan: ev.payload.plan,
                filePath: ev.payload.filePath,
                status: "pending",
                ts: nowIso,
              },
            ],
            nowIso,
          ),
        }
      }
      if (ev.payload.kind === "ask_question") {
        return {
          ...state,
          isStreaming: false,
          messages: capMessages(
            [
              ...state.messages,
              {
                kind: "question",
                requestId: ev.requestId,
                questions: ev.payload.questions,
                answers: null,
                ts: nowIso,
              },
            ],
            nowIso,
          ),
        }
      }
      return state
    }
    case "user_input.resolved": {
      // Find the matching pending row and patch its terminal state.
      // We don't remove the row — keep the question/plan visible so
      // the user can scroll back and remember what they answered.
      // In-place patch — no length change, cap not needed.
      const idx = findLastIndex(state.messages, (m) => {
        if (m.kind === "approval") return m.requestId === ev.requestId && m.status === "pending"
        if (m.kind === "question") return m.requestId === ev.requestId && m.answers === null
        return false
      })
      if (idx < 0) return state
      const target = state.messages[idx]
      let patched: ChatRow | null = null
      if (target?.kind === "approval" && ev.response.kind === "approve_plan") {
        patched = { ...target, status: ev.response.approve ? "approved" : "rejected" }
      } else if (target?.kind === "question" && ev.response.kind === "ask_question") {
        patched = { ...target, answers: ev.response.answers }
      }
      if (!patched) return state
      const next = state.messages.slice()
      next[idx] = patched
      return { ...state, messages: next }
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
    messages: capMessages(
      [...state.messages, { kind: "system", text: `runTask failed: ${message}`, ts: nowIso }],
      nowIso,
    ),
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
 * Walk one historical Message's neutral block list and append the
 * appropriate ChatRows to `rows`. `tool_call` creates a new tool row
 * (recorded in `toolIndexById`); `tool_result` patches the matching
 * row in place. `text` blocks become role-typed text rows; consecutive
 * texts buffer into one row so multi-text messages render as a single
 * paragraph.
 *
 * `thinking` blocks become the same reasoning rows produced by live
 * `reasoning.delta` events, so restart hydration matches the visible
 * stream.
 */
function appendRowsFromMessage(rows: ChatRow[], toolIndexById: Map<string, number>, m: Message): void {
  const ts = m.timestamp

  // Buffer consecutive text blocks so a multi-`text` message renders as
  // one chat row, but flush before each tool block so the document
  // order (text, tool, text → text-row, tool-row, text-row) is
  // preserved in the chat.
  let textBuf = ""
  const flushText = () => {
    if (textBuf.length === 0) return
    const row = textRow(m.role, textBuf, ts)
    if (row) rows.push(row)
    textBuf = ""
  }

  for (const block of m.blocks) {
    if (block.type === "text") {
      textBuf += block.text
      continue
    }

    if (block.type === "tool_call") {
      flushText()
      const id = block.callId.length > 0 ? block.callId : undefined
      const row: ChatRow = {
        kind: "tool",
        name: block.name,
        input: block.input,
        done: false,
        ts,
        toolUseId: id,
      }
      const idx = rows.length
      rows.push(row)
      if (id) toolIndexById.set(id, idx)
      continue
    }

    if (block.type === "tool_result") {
      flushText()
      const id = block.callId.length > 0 ? block.callId : undefined
      const idx = id !== undefined ? toolIndexById.get(id) : undefined
      const output = block.output
      if (idx !== undefined) {
        const target = rows[idx]
        if (target && target.kind === "tool") {
          rows[idx] = { ...target, done: true, output }
        }
      } else {
        // Orphan tool_result (no matching tool_call seen). Render as a
        // standalone result row so the user can still see what came
        // back; matches the live `applyEvent` fallback for the same
        // case.
        rows.push({ kind: "tool", name: "", input: undefined, output, done: true, ts })
      }
      continue
    }

    if (block.type === "thinking") {
      flushText()
      if (block.text.length > 0) rows.push({ kind: "reasoning", text: block.text, ts })
    }
    // Any future block type is intentionally dropped until the renderer
    // has a concrete row shape for it.
  }

  flushText()
}

function textRow(role: Message["role"], text: string, ts: string): ChatRow | null {
  const cleaned = cleanChatText(text)
  if (cleaned.length === 0) return null
  if (role === "user") return { kind: "user", text: cleaned, ts }
  if (role === "assistant") return { kind: "assistant", text: cleaned, ts }
  return { kind: "system", text: cleaned, ts }
}

/** ES2023 `findLastIndex` polyfill (some target envs don't have it). */
function findLastIndex<T>(arr: readonly T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]
    if (v !== undefined && pred(v)) return i
  }
  return -1
}
