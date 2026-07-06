/**
 * Transcript search — does a message match a query? Searches ALL of a message's
 * searchable text: prose, thinking, tool-call names + input summaries, and tool
 * result outputs, so a search for a filename, command, or error finds the
 * message that mentions it. Pure + React-free so it's unit-testable; the
 * transcript filters its message list with it.
 */

import type { ContentBlock, HistoryMessage } from "./history.ts"
import { textMatchesQuery } from "./text-match.ts"
import { outputText, toolInputSummary } from "./tool-display.ts"

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
    case "thinking":
      return block.text
    case "tool_call":
      return `${block.name} ${toolInputSummary(block)}`
    case "tool_result":
      return outputText(block.output)
  }
}

/** The concatenated searchable text of a message (all block kinds). */
export function messageSearchText(message: HistoryMessage): string {
  return message.blocks.map(blockText).join(" ")
}

/** Case-insensitive substring match over a message's searchable text. A blank
 *  query matches everything (the no-filter case). */
export function messageMatchesQuery(
  message: HistoryMessage,
  query: string,
): boolean {
  return textMatchesQuery(messageSearchText(message), query)
}

/** Whether a block should render given the "hide tool calls" toggle — tool
 *  calls are the noise you collapse to read the conversation prose; everything
 *  else (text, thinking) always shows. Tool results never render standalone
 *  (they attach to their call), so they're irrelevant here. */
export function blockVisible(block: ContentBlock, hideTools: boolean): boolean {
  return !(hideTools && block.type === "tool_call")
}

/** Whether a message would render ANY row — mirrors exactly what MessageRow
 *  emits (NOT blockVisible-by-type): non-blank text or thinking, or a tool_call
 *  when tools aren't hidden. A tool_result never renders standalone, and an
 *  empty/whitespace text/thinking block is skipped. Used so the transcript's
 *  shown/total count, the rendered rows, and the "no matches" empty state all
 *  agree (otherwise a tool_result-only Codex turn, or an empty block, counts
 *  but renders blank). */
export function messageRendersAnything(
  message: HistoryMessage,
  hideTools: boolean,
): boolean {
  return message.blocks.some((b) => {
    if (b.type === "text" || b.type === "thinking") return b.text.trim() !== ""
    if (b.type === "tool_call") return !hideTools
    return false // tool_result: never standalone
  })
}
