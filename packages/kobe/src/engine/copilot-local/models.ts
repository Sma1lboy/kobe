import type { ModelChoice, ModelEffortLevel } from "@/types/engine"

export const COPILOT_MODELS: readonly ModelChoice[] = [
  {
    vendor: "copilot",
    id: "auto",
    label: "Copilot auto",
    hint: "let Copilot choose",
  },
  {
    vendor: "copilot",
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    hint: "fast default",
  },
  {
    vendor: "copilot",
    id: "gpt-5.2",
    label: "GPT-5.2",
    hint: "general coding",
  },
  {
    vendor: "copilot",
    id: "claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    hint: "Copilot-hosted",
  },
  {
    vendor: "copilot",
    id: "claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    hint: "quick answers",
  },
]

const COPILOT_SELECTABLE_MODEL_IDS = new Set(COPILOT_MODELS.map((m) => m.id))

export function normalizeCopilotCliModel(modelId: string | undefined): string | undefined {
  const trimmed = modelId?.trim()
  if (!trimmed || trimmed === "auto") return undefined
  return COPILOT_SELECTABLE_MODEL_IDS.has(trimmed) ? trimmed : undefined
}

export function normalizeCopilotCliEffort(
  modelId: string | undefined,
  effort: ModelEffortLevel | undefined,
): ModelEffortLevel | undefined {
  if (!effort) return undefined
  const model = normalizeCopilotCliModel(modelId)
  if (!model) return undefined
  return COPILOT_MODELS.some((m) => m.id === model && m.effort === effort) ? effort : undefined
}

export function copilotContextWindowFor(_modelId: string): number {
  return 0
}
