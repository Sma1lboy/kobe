import type { EngineCapabilities, EngineIdentity } from "@/types/engine"
import { COPILOT_MODELS, copilotContextWindowFor } from "./models"
import { resolveCopilotDefaultModelId } from "./settings"

export const copilotCapabilities: EngineCapabilities = {
  vendorId: "copilot",
  label: "GitHub Copilot",
  models: COPILOT_MODELS,
  permissionModes: [
    { id: "default", label: "full access" },
    { id: "plan", label: "plan mode" },
  ],
  defaultModelId: resolveCopilotDefaultModelId,
  contextWindowFor: copilotContextWindowFor,
}

export const copilotIdentity: EngineIdentity = {
  vendorId: "copilot",
  productName: "GitHub Copilot CLI",
  shortName: "Copilot",
  assistantName: "Copilot",
  inputPlaceholder: "Ask Copilot…",
}
