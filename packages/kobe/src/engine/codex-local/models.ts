/**
 * Codex model catalog + context-window math.
 *
 * Codex CLI exposes a small fixed family today; new ids land
 * occasionally. Keep this list narrow — picker entries here should be
 * ones we've actually run and can stand behind. Free-form pinned ids
 * still work end-to-end because the runtime never enum-validates the
 * id; only the picker shortens it.
 */

import type { ModelChoice } from "@/types/engine"

export const CODEX_MODELS: readonly ModelChoice[] = [
  { vendor: "codex", id: "gpt-5-codex", label: "GPT-5 Codex", hint: "openai codex, default" },
  { vendor: "codex", id: "gpt-5", label: "GPT-5" },
  { vendor: "codex", id: "o3", label: "o3", hint: "reasoning" },
] as const

/**
 * Default model id when codex's own config doesn't pin one. Mirrors
 * what `codex exec` falls back to today on a fresh install.
 */
export const CODEX_FALLBACK_DEFAULT_MODEL_ID = "gpt-5-codex"

const DEFAULT_CTX = 400_000

/**
 * Max context tokens for a Codex model id. Codex's published context
 * windows aren't surfaced in the CLI today, so we conservatively
 * report 400k for the default family and let the meter render
 * meaningful percentages. Tune per-id as we observe real limits.
 */
export function codexContextWindowFor(_modelId: string): number {
  return DEFAULT_CTX
}
