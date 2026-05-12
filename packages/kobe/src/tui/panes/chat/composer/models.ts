/**
 * Deprecated path — model catalog + label helpers moved into the engine
 * registry (`@/engine/registry`) and the claude-code adapter
 * (`@/engine/claude-code-local/models`).
 *
 * New code should import from those locations directly:
 *   - `allModels()` / `modelLabelFor()` / `defaultCapabilities` → `@/engine/registry`
 *   - `CLAUDE_MODELS` (vendor-specific list) → `@/engine/claude-code-local/models`
 *
 * This shim stays around for one release in case an out-of-tree
 * consumer imports the old path.
 */

export type { ModelChoice } from "@/types/engine"
export { CLAUDE_MODELS as MODEL_CHOICES } from "@/engine/claude-code-local/models"
export { defaultCapabilities, modelLabelFor } from "@/engine/registry"
export { resolveClaudeDefaultModelId as resolveDefaultModelId } from "@/engine/claude-code-local/settings"
