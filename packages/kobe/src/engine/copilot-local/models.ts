import type { ModelChoice, ModelEffortLevel } from "@/types/engine"

export const COPILOT_FALLBACK_DEFAULT_MODEL_ID = "gpt-5-mini"

const COPILOT_GPT52_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const satisfies readonly ModelEffortLevel[]

export const COPILOT_MODELS: readonly ModelChoice[] = [
  { vendor: "copilot", id: "auto", label: "Copilot auto", hint: "let Copilot choose" },
  { vendor: "copilot", id: "gpt-5.2", label: "GPT-5.2", hint: "powerful default" },
  ...COPILOT_GPT52_EFFORT_LEVELS.map((effort) => ({
    vendor: "copilot" as const,
    id: "gpt-5.2",
    effort,
    level: effort,
    label: `GPT-5.2 · ${effort}`,
    hint: `${effort} reasoning`,
  })),
  { vendor: "copilot", id: "gpt-5-mini", label: "GPT-5 mini", hint: "fast fallback" },
  { vendor: "copilot", id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", hint: "Copilot-hosted Claude" },
]

export function copilotContextWindowFor(_modelId: string): number {
  return 0
}
