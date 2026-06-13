/**
 * User-editable board quick-action prompt templates (Settings → Board
 * quick actions). Stored HOST-side in state.json via the bridge — the
 * templates are machine config, not browser config, so the TUI and any
 * future surface read the same values. kobe's non-negotiable clauses
 * (review's done authorization, PR's reply-with-URL) are appended AFTER
 * the template at send time (lib/review.ts) and are never stored.
 */

export interface QuickPrompts {
  review: string | null
  pr: string | null
}

/** Fail-open: a fetch failure means "use the built-in defaults". */
export async function fetchQuickPrompts(): Promise<QuickPrompts> {
  try {
    const res = await fetch("/api/quick-prompts")
    if (!res.ok) return { review: null, pr: null }
    const json = (await res.json()) as Partial<QuickPrompts>
    return {
      review: typeof json.review === "string" ? json.review : null,
      pr: typeof json.pr === "string" ? json.pr : null,
    }
  } catch {
    return { review: null, pr: null }
  }
}

export async function saveQuickPrompts(prompts: {
  review: string
  pr: string
}): Promise<void> {
  const res = await fetch("/api/quick-prompts", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prompts),
  })
  if (!res.ok) throw new Error(`save failed (${res.status})`)
}
