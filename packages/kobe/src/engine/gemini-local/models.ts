import type { ModelChoice } from "@/types/engine"

export const GEMINI_MODELS: readonly ModelChoice[] = [
  {
    vendor: "gemini",
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro preview",
    hint: "most capable",
  },
  {
    vendor: "gemini",
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash preview",
    hint: "fast preview",
  },
  {
    vendor: "gemini",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "stable fallback",
  },
]

export function geminiContextWindowFor(modelId: string): number {
  if (modelId.includes("pro") || modelId.includes("flash")) {
    return 1_048_576
  }
  return 0
}
