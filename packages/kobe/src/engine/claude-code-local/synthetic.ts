import type { ContentBlock } from "@/types/engine"

export function isSyntheticClaudeRecord(record: Record<string, unknown>): boolean {
  return record.isMeta === true || record.isCompactSummary === true
}

export function isClaudeCommandBreadcrumb(blocks: readonly ContentBlock[]): boolean {
  if (blocks.length === 0) return false
  for (const b of blocks) {
    if (b.type !== "text") return false
    const t = b.text.trim()
    if (!t.startsWith("<command-name>") && !t.startsWith("<command-message>") && !t.startsWith("<local-command")) {
      return false
    }
  }
  return true
}
