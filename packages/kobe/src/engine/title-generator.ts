/**
 * Engine-owned task title generation contract.
 *
 * Neutral layers call this through `engineEntry(vendor).titleGenerator`;
 * engines decide whether they can produce an AI title. Returning `null`
 * means the daemon keeps its deterministic fallback title.
 */

export interface EngineTitleGenerator {
  generateTitle(input: string, options?: { readonly signal?: AbortSignal }): Promise<string | null>
}

export const NOOP_TITLE_GENERATOR: EngineTitleGenerator = {
  async generateTitle() {
    return null
  },
}

const TITLE_MAX_CHARS = 80

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null
  if (value.includes("\n") || value.includes("\r")) return null
  const title = value.replace(/\s+/g, " ").trim()
  if (!title || title.length > TITLE_MAX_CHARS) return null
  return title
}

/**
 * Parse title generator output. Supports both direct structured output
 * (`{"title":"..."}`) and Claude print-mode JSON (`{"result":"...json..."}`).
 */
export function parseGeneratedTitleJson(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const direct = titleFromObject(parsed)
  if (direct) return direct
  if (!parsed || typeof parsed !== "object") return null
  const result = (parsed as Record<string, unknown>).result
  if (typeof result !== "string") return null
  try {
    return titleFromObject(JSON.parse(result))
  } catch {
    return null
  }
}

function titleFromObject(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return cleanTitle((value as Record<string, unknown>).title)
}
