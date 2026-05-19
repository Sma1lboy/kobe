/**
 * Codex adapter capabilities — the single descriptor kobe's neutral
 * layers (orchestrator, TUI) consult for codex-specific knowledge.
 */

import type { EngineCapabilities, EngineIdentity } from "@/types/engine"
import { CODEX_MODELS, codexContextWindowFor } from "./models"
import { resolveCodexDefaultModelId } from "./settings"

export const codexCapabilities: EngineCapabilities = {
  vendorId: "codex",
  label: "Codex",
  models: CODEX_MODELS,
  permissionModes: [
    { id: "default", label: "full access" },
    { id: "plan", label: "plan mode" },
  ],
  defaultModelId: resolveCodexDefaultModelId,
  contextWindowFor: codexContextWindowFor,
  smallFastModelId: () => "gpt-5.4-mini",
}

export const codexIdentity: EngineIdentity = {
  vendorId: "codex",
  productName: "Codex",
  shortName: "Codex",
  assistantName: "Codex",
  inputPlaceholder: "Ask Codex…",
}
