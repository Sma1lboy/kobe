/** Title cap for `deriveTitleFromPrompt`. Short enough to fit in a 42-char sidebar with status badge prefix. */
export const TITLE_CHAR_CAP = 40

/**
 * Reduce an arbitrary user prompt to a one-line sidebar label.
 */
export function deriveTitleFromPrompt(prompt: string): string {
  if (typeof prompt !== "string") return ""
  const collapsed = prompt.replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return ""
  if (collapsed.length <= TITLE_CHAR_CAP) return collapsed
  return `${collapsed.slice(0, TITLE_CHAR_CAP)}…`
}

/**
 * Build `kobe/<slug>-<ulid-suffix-4>` from a user-supplied title and
 * a freshly-minted ulid.
 */
export function autoBranch(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  const suffix = taskId.slice(-4).toLowerCase()
  const base = slug || "task"
  return `kobe/${base}-${suffix}`
}
