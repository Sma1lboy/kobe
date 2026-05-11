/**
 * Claude-code adapter capabilities.
 *
 * The single object kobe's neutral layers (orchestrator, TUI) consult
 * for anything vendor-specific about claude. See {@link EngineCapabilities}
 * for the contract.
 */

import type { EngineCapabilities } from "@/types/engine"
import { CLAUDE_MODELS, claudeContextWindowFor } from "./models"
import { resolveClaudeDefaultModelId } from "./settings"

export const claudeCapabilities: EngineCapabilities = {
  vendorId: "claude",
  label: "Claude Code",
  models: CLAUDE_MODELS,
  defaultModelId: resolveClaudeDefaultModelId,
  contextWindowFor: claudeContextWindowFor,
}
