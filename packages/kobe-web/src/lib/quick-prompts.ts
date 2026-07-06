/**
 * User-editable board quick-action prompt templates (Settings → Board
 * quick actions). Stored HOST-side in state.json via the bridge — the
 * templates are machine config, not browser config, so the TUI and any
 * future surface read the same values. kobe's non-negotiable clauses
 * (review's done authorization, PR's reply-with-URL) are appended AFTER
 * the template at send time (lib/review.ts) and are never stored.
 */

import { api } from "./api-client.ts"

export interface QuickPrompts {
  review: string | null
  pr: string | null
}

/** Fail-open: a fetch failure means "use the built-in defaults". */
export async function fetchQuickPrompts(): Promise<QuickPrompts> {
  const json = await api.getOr<Partial<QuickPrompts>>(
    "/api/quick-prompts",
    {},
    { label: "load quick prompts" },
  )
  return {
    review: typeof json.review === "string" ? json.review : null,
    pr: typeof json.pr === "string" ? json.pr : null,
  }
}

export async function saveQuickPrompts(prompts: {
  review: string
  pr: string
}): Promise<void> {
  await api.put<void>("/api/quick-prompts", prompts, {
    label: "save quick prompts",
  })
}
