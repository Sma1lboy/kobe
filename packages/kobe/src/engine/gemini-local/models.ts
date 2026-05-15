import type { ModelChoice } from "@/types/engine"

export const GEMINI_MODELS: readonly ModelChoice[] = [
  {
    vendor: "gemini",
    id: "auto",
    label: "Gemini auto",
    hint: "Gemini CLI default model routing",
  },
  {
    vendor: "gemini",
    id: "pro",
    label: "Gemini Pro",
    hint: "Alias for Gemini CLI's current pro model",
  },
  {
    vendor: "gemini",
    id: "flash",
    label: "Gemini Flash",
    hint: "Fast balanced Gemini model",
  },
  {
    vendor: "gemini",
    id: "flash-lite",
    label: "Gemini Flash Lite",
    hint: "Fastest Gemini CLI alias",
  },
  {
    vendor: "gemini",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
  },
  {
    vendor: "gemini",
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
  },
  {
    vendor: "gemini",
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
  },
  {
    vendor: "gemini",
    id: "gemini-3-pro-preview",
    label: "Gemini 3 Pro preview",
  },
  {
    vendor: "gemini",
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash preview",
  },
]

export function geminiContextWindowFor(modelId: string): number {
  if (modelId === "auto" || modelId === "pro" || modelId.includes("pro") || modelId.includes("flash")) {
    return 1_048_576
  }
  return 0
}
