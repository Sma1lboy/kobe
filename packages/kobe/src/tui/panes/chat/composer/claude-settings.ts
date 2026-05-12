/**
 * Deprecated path — moved into the claude-code adapter at
 * `@/engine/claude-code-local/settings`. New code should import from
 * there, or — for vendor-neutral consumers — go through
 * {@link AIEngine.capabilities.defaultModelId} / the engine registry.
 */
export {
  _resetClaudeSettingsCache,
  CLAUDE_FALLBACK_DEFAULT_MODEL_ID as FALLBACK_DEFAULT_MODEL_ID,
  type ClaudeSettings,
  readClaudeSettings,
  resolveClaudeDefaultModelId as resolveDefaultModelId,
} from "@/engine/claude-code-local/settings"
