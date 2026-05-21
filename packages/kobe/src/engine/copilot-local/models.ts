import type { ModelChoice } from "@/types/engine"

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
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    hint: "deeper coding",
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

export function copilotContextWindowFor(_modelId: string): number {
  return 0
}
