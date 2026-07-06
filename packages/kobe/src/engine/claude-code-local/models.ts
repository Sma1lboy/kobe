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

export function claudeContextWindowFor(modelId: string): number {
  return /1m/i.test(modelId) ? LONG_CTX : STD_CTX
}
