import type { ContentBlock } from "@/types/content"

export function normalizeClaudeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const out: ContentBlock[] = []
  for (const block of content) {
    if (typeof block === "string") {
      if (block.length > 0) out.push({ type: "text", text: block })
      continue
    }
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>

    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text })
      continue
    }

    if (b.type === "tool_use") {
      out.push({
        type: "tool_call",
        callId: typeof b.id === "string" ? b.id : "",
        name: typeof b.name === "string" ? b.name : "",
        input: b.input,
      })
      continue
    }

    if (b.type === "tool_result") {
      out.push({
        type: "tool_result",
        callId: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
        output: b.content,
        isError: b.is_error === true,
      })
      continue
    }

    if (b.type === "thinking" && typeof b.thinking === "string") {
      out.push({ type: "thinking", text: b.thinking })
    }
  }
  return out
}
