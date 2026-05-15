/**
 * Hydrate `ChatRow[]` from a session's persisted `Message[]`.
 *
 * Lives apart from `store.ts` because this is a one-shot transformer at
 * task mount / session switch — completely separate from the live-event
 * reducer (`applyEvent`). The shapes are different too: engine
 * {@link Message} blocks come from JSONL on disk, while live events come
 * from the spawn pump. Mixing both in `store.ts` made it hard to read
 * either.
 *
 * Public entry: {@link setMessagesFromHistory}. The block walker
 * (`appendRowsFromMessage`) and the role→row mapper (`textRow`) are
 * file-local helpers; nothing else needs them.
 */

import type { SessionUsageMetrics } from "../../../session/usage-metrics.ts"
import type { Message } from "../../../types/engine.ts"
import { cleanChatText } from "./noise-filter.ts"
import type { ChatRow, ChatState } from "./row-types.ts"
import { capMessages } from "./scrollback.ts"

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
