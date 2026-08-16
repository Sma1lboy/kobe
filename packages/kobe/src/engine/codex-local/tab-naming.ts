import type { EngineTabNamingPolicy } from "../tab-naming-policy"

/** Codex-only transcript decorations that must not become a tab name. */
function isAttachmentMetadata(text: string): boolean {
  const trimmed = text.trim()
  return (
    /^<image name=\[Image #\d+\] path="[^"]+">$/.test(trimmed) ||
    trimmed === "</image>" ||
    /^\[codex: (?:input_)?image\]$/.test(trimmed)
  )
}

export const codexTabNamingPolicy: EngineTabNamingPolicy = {
  trigger: "immediate",
  retryDelaysMs: [250, 1_000, 2_000, 5_000],
  promptText: (message) =>
    message.blocks
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .filter((text) => !isAttachmentMetadata(text))
      .join(" "),
}
