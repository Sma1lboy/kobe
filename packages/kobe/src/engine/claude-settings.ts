/**
 * Transitional re-export shim. The settings reader moved into the
 * claude-code adapter at `engine/claude-code-local/settings.ts` so all
 * vendor-specific knowledge (file path, schema) sits inside the adapter.
 *
 * New code should import from `@/engine/claude-code-local/settings`,
 * or — for vendor-neutral consumers — go through
 * {@link AIEngine.capabilities.defaultModelId}.
 */
export {
  _resetClaudeSettingsCache,
  CLAUDE_FALLBACK_DEFAULT_MODEL_ID as FALLBACK_DEFAULT_MODEL_ID,
  type ClaudeSettings,
  readClaudeSettings,
  resolveClaudeDefaultModelId as resolveDefaultModelId,
} from "./claude-code-local/settings"
