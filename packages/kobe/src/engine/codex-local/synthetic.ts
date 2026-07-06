import { normalizeCodexContent } from "./normalize"

type CodexTextLikeBlock = {
  readonly type: string
  readonly text?: string
}

export function isSyntheticCodexUserRow(blocks: readonly CodexTextLikeBlock[]): boolean {
  if (blocks.length === 0) return false
  for (const b of blocks) {
    if (b.type !== "text") return false
    const t = (b.text ?? "").trim()
    if (!isEnvironmentContextEnvelope(t) && !isInstructionsEnvelope(t)) return false
  }
  return true
}

export function visibleCodexUserText(content: unknown): string | null {
  const blocks = normalizeCodexContent(content)
  if (isSyntheticCodexUserRow(blocks)) return null
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim()
  return text.length > 0 ? text : null
}

function isEnvironmentContextEnvelope(text: string): boolean {
  return text.startsWith("<environment_context>") && text.endsWith("</environment_context>")
}

function isInstructionsEnvelope(text: string): boolean {
  return (
    text.startsWith("# AGENTS.md instructions for ") &&
    text.includes("\n<INSTRUCTIONS>\n") &&
    text.endsWith("</INSTRUCTIONS>")
  )
}
