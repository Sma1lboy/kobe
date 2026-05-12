/**
 * Codex `response_item` content → kobe neutral {@link ContentBlock}[].
 *
 * Codex's on-disk shape (rollout JSONL):
 *   - { type: "input_text",  text: "..." }  — user-side text
 *   - { type: "output_text", text: "..." }  — assistant-side text
 *   - Other types (image, tool_use, …) are surfaced as text placeholders
 *     so the renderer doesn't blank a row; specialised blocks can be
 *     mapped later as we observe them in real sessions.
 */

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
    // Future: map image / tool_use / etc. when we encounter them. For
    // now, leave a placeholder so the chat row renders SOMETHING rather
    // than silently dropping the record.
    if (t) blocks.push({ type: "text", text: `[codex: ${t}]` })
  }
  return blocks
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
