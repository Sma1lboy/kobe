/**
 * Claude-code model catalog + context-window math.
 *
 * Anthropic publishes model ids and ships new ones regularly — when an
 * id is rotated, edit this list rather than relying on aliases
 * (`opus`/`sonnet`), which the CLI resolves to the latest of a family
 * at *its* runtime, not ours, and would make the displayed label drift
 * away from what the engine actually loaded.
 *
 * No "default / claude-code" pseudo-entry: claude-code itself doesn't
 * surface one — the unpinned state simply resolves to the real default
 * model (Sonnet 4.6 for PAYG/Pro/Enterprise/Team Standard, per
 * `getDefaultMainLoopModelSetting` in refs/claude-code/src/utils/model/
 * model.ts). The footer shows that real name; the picker lists real
 * models only.
 */

import type { ModelChoice } from "@/types/engine"

export const CLAUDE_MODELS: readonly ModelChoice[] = [
  { vendor: "claude", id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M", hint: "long context, default" },
  { vendor: "claude", id: "claude-opus-4-7", label: "Opus 4.7", hint: "most capable, slowest" },
  { vendor: "claude", id: "claude-sonnet-4-6[1m]", label: "sonnet 4.6 (1M)", hint: "long context" },
  { vendor: "claude", id: "claude-sonnet-4-6", label: "sonnet 4.6" },
  { vendor: "claude", id: "claude-haiku-4-5-20251001", label: "haiku 4.5", hint: "fastest, cheapest" },
] as const

const LONG_CTX = 1_000_000
const STD_CTX = 200_000

function parseContextWindowSize(modelIdentifier: string): number | null {
  const delimitedMatch = /(?:\(|\[)\s*(\d+(?:[,_]\d+)*(?:\.\d+)?)\s*([km])\s*(?:\)|\])/i.exec(modelIdentifier)
  if (delimitedMatch?.[1] && delimitedMatch[2]) {
    const parsed = Number.parseFloat(delimitedMatch[1].replace(/[,_]/g, ""))
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed * (delimitedMatch[2].toLowerCase() === "m" ? 1_000_000 : 1000))
    }
  }

  const contextMatch = /\b(\d+(?:[,_]\d+)*(?:\.\d+)?)\s*([km])(?:\s*(?:token\s*)?context)?\b/i.exec(modelIdentifier)
  if (!contextMatch?.[1] || !contextMatch[2]) return null

  const parsed = Number.parseFloat(contextMatch[1].replace(/[,_]/g, ""))
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.round(parsed * (contextMatch[2].toLowerCase() === "m" ? 1_000_000 : 1000))
}

/**
 * Max context tokens for a Claude model id. `[1m]` suffix implies the
 * 1M-context variant; unknown ids fall back to 200k so the meter still
 * renders something rather than reading zero.
 */
export function claudeContextWindowFor(modelId: string): number {
  const parsed = parseContextWindowSize(modelId)
  if (parsed !== null) return parsed
  if (modelId.includes("[1m]")) return LONG_CTX
  const inCatalog = CLAUDE_MODELS.some((m) => m.id === modelId)
  if (inCatalog) return STD_CTX
  // Defensive — accept variant spellings used by ad-hoc pinned ids.
  if (modelId.includes("1m") || modelId.includes("[1M]")) return LONG_CTX
  return STD_CTX
}
