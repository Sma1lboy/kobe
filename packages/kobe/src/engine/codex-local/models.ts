/**
 * Codex model catalog + context-window math.
 *
 * Codex CLI accepts two auth modes — OpenAI API key and ChatGPT
 * account — and the set of legal model ids differs between them:
 *
 *   - API-key callers can pin custom ids like `gpt-5-codex` / `o3` /
 *     `gpt-5` directly.
 *   - ChatGPT-account callers get a narrower allowed list and codex
 *     returns a 400 `invalid_request_error` ("The 'X' model is not
 *     supported when using Codex with a ChatGPT account.") for
 *     anything outside it.
 *
 * The picker entries below are the **intersection** — ids that work
 * for *both* auth modes — sourced from codexui's MODEL_FALLBACK_ID
 * pattern (`refs/codexui/src/composables/useDesktopState.ts:610`)
 * and the codex 0.130 CLI defaults. Free-form pinned ids still work
 * end-to-end because the runtime never enum-validates them; only the
 * picker shortens to this curated list.
 *
 * When `claude-code`-style model resolution lands ("read whatever the
 * vendor's own settings file pins"), `gpt-5.5` etc. surface
 * automatically through `resolveCodexDefaultModelId` reading
 * `~/.codex/config.toml`.
 */

import type { ModelChoice } from "@/types/engine"

export const CODEX_MODELS: readonly ModelChoice[] = [
  { vendor: "codex", id: "gpt-5.5", label: "GPT-5.5", hint: "latest, ChatGPT-account compatible" },
  { vendor: "codex", id: "gpt-5.4", label: "GPT-5.4", hint: "stable" },
  { vendor: "codex", id: "gpt-5.4-mini", label: "GPT-5.4 mini", hint: "fastest, always supported" },
] as const

/**
 * Default model id when codex's own config doesn't pin one.
 *
 * Picked to be **always supported** on both auth modes — codexui's
 * `MODEL_FALLBACK_ID` is the same value for the same reason. ChatGPT
 * account holders who haven't set up `~/.codex/config.toml` get a
 * working session out of the box instead of a 400.
 */
export const CODEX_FALLBACK_DEFAULT_MODEL_ID = "gpt-5.4-mini"

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
