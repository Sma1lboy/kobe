/**
 * Lazy branch-name suggestion via the selected engine.
 *
 * As of KOB-16 the implementation lives on {@link MetadataSuggester}
 * (in `metadata-suggester.ts`); this module is now a thin shim that
 * delegates to a process-wide default instance.
 *
 * New code should hold a `MetadataSuggester` instance directly —
 * either the orchestrator's injected one, or a fresh local instance —
 * rather than reaching for the singleton here. Sticking to instance
 * methods keeps the surface testable (fakes can be injected) and
 * future-proof against callers that need scoped config.
 */

import { MetadataSuggester, type MetadataSuggestionContext } from "./metadata-suggester.ts"

const defaultSuggester = new MetadataSuggester()

/**
 * Ask the selected engine for a kebab-case slug for `prompt`.
 *
 * Returns a slug *without* any `kobe/` prefix or ulid suffix — the
 * caller composes the final branch name. Returns null on any failure
 * (prompt empty, engine error, malformed response,
 * timeout).
 *
 * @deprecated Prefer constructing or injecting a {@link MetadataSuggester}
 *   and calling `suggestBranchSlug` on it. This top-level export
 *   stays only so existing imports keep working.
 */
export function suggestBranchSlug(prompt: string, context: MetadataSuggestionContext): Promise<string | null> {
  return defaultSuggester.suggestBranchSlug(prompt, context)
}
