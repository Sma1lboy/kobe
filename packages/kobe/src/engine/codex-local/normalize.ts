import type { ContentBlock } from "@/types/content"

export function normalizeCodexContent(raw: unknown): ContentBlock[] {
  if (typeof raw === "string") {
    return raw.length > 0 ? [{ type: "text", text: raw }] : []
  }
  if (!Array.isArray(raw)) return []
  const blocks: ContentBlock[] = []
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.length > 0) blocks.push({ type: "text", text: item })
      continue
    }
    if (!isObject(item)) continue
    const t = typeof item.type === "string" ? (item.type as string) : undefined
    if (t === "input_text" || t === "output_text") {
      const text = typeof item.text === "string" ? (item.text as string) : ""
      if (text.length > 0) blocks.push({ type: "text", text })
      continue
    }
    if (t) blocks.push({ type: "text", text: `[codex: ${t}]` })
  }
  return blocks
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
