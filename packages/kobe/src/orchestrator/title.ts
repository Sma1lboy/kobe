/**
 * Title and branch derivation (v0.6).
 *
 * Used by the orchestrator's `createTask` when the user gives a title
 * but no explicit branch — we derive a `kobe/<slug>-<id>` name.
 * `deriveTitleFromPrompt` is kept for the rare case where we still
 * accept a free-form prompt as a title source (e.g. external callers
 * via the daemon RPC); v0.6 itself doesn't surface that path.
 */

/** Title cap. Kept generous for branch slugs; the compact sidebar truncates visually. */
export const TITLE_CHAR_CAP = 40

/**
 * Reduce an arbitrary user prompt to a one-line sidebar label.
 */
export function deriveTitleFromPrompt(prompt: string): string {
  if (typeof prompt !== "string") return ""
  const collapsed = prompt.replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return ""
  // Truncate on code-POINT boundaries, not UTF-16 code units: a bare
  // `.slice(0, CAP)` can bisect a surrogate pair (emoji / astral char) and
  // leave an orphaned half that renders as a replacement glyph in the sidebar.
  const points = [...collapsed]
  if (points.length <= TITLE_CHAR_CAP) return collapsed
  return `${points.slice(0, TITLE_CHAR_CAP).join("")}…`
}

/**
 * Build `kobe/<slug>-<ulid-suffix-6>` from a user-supplied title and a
 * freshly-minted ulid. The 6-char suffix comes from the ulid's random
 * tail, so two tasks created from the same placeholder title still get
 * distinct branches (branch collisions failed `git worktree
 * add -b`). MUST be passed the real task id, never a fixed placeholder.
 */
export function autoBranch(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  const suffix = taskId.slice(-6).toLowerCase()
  const base = slug || "task"
  return `kobe/${base}-${suffix}`
}
