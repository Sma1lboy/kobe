/**
 * Claude-code adapter capabilities.
 *
 * The single object kobe's neutral layers (orchestrator, TUI) consult
 * for anything vendor-specific about claude. See {@link EngineCapabilities}
 * for the contract.
 */

import type { EngineCapabilities, EngineIdentity } from "@/types/engine"
import { CLAUDE_MODELS, claudeContextWindowFor } from "./models"
import { resolveClaudeDefaultModelId } from "./settings"

export const claudeCapabilities: EngineCapabilities = {
  vendorId: "claude",
  label: "Claude Code",
  models: CLAUDE_MODELS,
  permissionModes: [
    { id: "default", label: "default" },
    { id: "plan", label: "plan mode" },
  ],
  defaultModelId: resolveClaudeDefaultModelId,
  contextWindowFor: claudeContextWindowFor,
  smallFastModelId: () => "claude-haiku-4-5-20251001",
}

export const claudeIdentity: EngineIdentity = {
  vendorId: "claude",
  productName: "Claude Code",
  shortName: "Claude",
  assistantName: "Claude",
  inputPlaceholder: "Ask Claude…",
}
