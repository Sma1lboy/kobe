import type { AiSdkConversationMessage } from "@/engine/ai-sdk/harness-turn"
import type { UIMessage } from "ai"
import type { ChatItem } from "./ChatRow"

function textPartText(part: UIMessage["parts"][number]): string {
  if (part.type !== "text") return ""
  return typeof part.text === "string" ? part.text.trim() : ""
}

function assistantText(msg: UIMessage): string {
  return msg.parts.map(textPartText).filter(Boolean).join("\n\n")
}

export function chatItemsToAiSdkHistory(items: readonly ChatItem[]): readonly AiSdkConversationMessage[] {
  const out: AiSdkConversationMessage[] = []
  for (const item of items) {
    if (item.kind === "prompt") {
      const text = item.text.trim()
      if (text) out.push({ role: "user", text })
      continue
    }
    if (item.kind !== "ui") continue
    const text = assistantText(item.msg)
    if (text) out.push({ role: "assistant", text })
  }
  return out
}
