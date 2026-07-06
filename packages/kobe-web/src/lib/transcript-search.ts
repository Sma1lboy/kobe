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

export function messageSearchText(message: HistoryMessage): string {
  return message.blocks.map(blockText).join(" ")
}

export function messageMatchesQuery(
  message: HistoryMessage,
  query: string,
): boolean {
  return textMatchesQuery(messageSearchText(message), query)
}

export function blockVisible(block: ContentBlock, hideTools: boolean): boolean {
  return !(hideTools && block.type === "tool_call")
}

export function messageRendersAnything(
  message: HistoryMessage,
  hideTools: boolean,
): boolean {
  return message.blocks.some((b) => {
    if (b.type === "text" || b.type === "thinking") return b.text.trim() !== ""
    if (b.type === "tool_call") return !hideTools
    return false
  })
}
