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

import type { ModelChoice, ModelEffortLevel } from "@/types/engine"

const CLAUDE_OPUS_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelEffortLevel[]

function opus47EffortChoices(id: string, label: string): readonly ModelChoice[] {
  return CLAUDE_OPUS_EFFORT_LEVELS.map((effort) => ({
    vendor: "claude",
    id,
    effort,
    level: effort,
    label: `${label} · ${effort}`,
    hint: effort === "max" ? "deepest reasoning" : `${effort} effort`,
  }))
}

export const CLAUDE_MODELS: readonly ModelChoice[] = [
  { vendor: "claude", id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M", hint: "long context, default" },
  ...opus47EffortChoices("claude-opus-4-7[1m]", "Opus 4.7 1M"),
  { vendor: "claude", id: "claude-opus-4-7", label: "Opus 4.7", hint: "most capable, slowest" },
  ...opus47EffortChoices("claude-opus-4-7", "Opus 4.7"),
  { vendor: "claude", id: "claude-sonnet-4-6[1m]", label: "sonnet 4.6 (1M)", hint: "long context" },
  { vendor: "claude", id: "claude-sonnet-4-6", label: "sonnet 4.6" },
  { vendor: "claude", id: "claude-haiku-4-5-20251001", label: "haiku 4.5", hint: "fastest, cheapest" },
] as const

const LONG_CTX = 1_000_000
const STD_CTX = 200_000

/**
 * Max context tokens for a Claude model id. The only context-window variant
 * across the catalog (and ad-hoc pinned ids) is the `[1m]` suffix — the
 * 1M-context build; everything else is the standard 200k window.
 *
 * ponytail: matched loosely (`/1m/i`) so variant spellings (`[1M]`, a bare
 * `-1m`) still resolve. No catalog id contains an incidental `1m`.
 */
export function claudeContextWindowFor(modelId: string): number {
  return /1m/i.test(modelId) ? LONG_CTX : STD_CTX
}
