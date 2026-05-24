import type { EngineCapabilities, EngineIdentity } from "@/types/engine"
import { GEMINI_MODELS, geminiContextWindowFor } from "./models"
import { resolveGeminiDefaultModelId } from "./settings"

export const geminiCapabilities: EngineCapabilities = {
  vendorId: "gemini",
  label: "Gemini CLI",
  models: GEMINI_MODELS,
  permissionModes: [
    { id: "default", label: "full access" },
    { id: "plan", label: "plan mode" },
  ],
  defaultModelId: resolveGeminiDefaultModelId,
  contextWindowFor: geminiContextWindowFor,
  smallFastModelId: () => "gemini-3-flash-preview",
}

export const geminiIdentity: EngineIdentity = {
  vendorId: "gemini",
  productName: "Gemini CLI",
  shortName: "Gemini",
  assistantName: "Gemini",
  inputPlaceholder: "Ask Gemini…",
}
