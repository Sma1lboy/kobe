/**
 * Codex adapter capabilities — the single descriptor kobe's neutral
 * layers (orchestrator, TUI) consult for codex-specific knowledge.
 */

import type { EngineCapabilities } from "@/types/engine"
import { CODEX_MODELS, codexContextWindowFor } from "./models"
import { resolveCodexDefaultModelId } from "./settings"

export const codexCapabilities: EngineCapabilities = {
  vendorId: "codex",
  label: "Codex",
  models: CODEX_MODELS,
  defaultModelId: resolveCodexDefaultModelId,
  contextWindowFor: codexContextWindowFor,
}
