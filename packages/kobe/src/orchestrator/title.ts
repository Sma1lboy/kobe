/**
 * Title derivation + placeholder-branch recognition.
 *
 * Branch NAMES are no longer derived here — `branch-style.ts` owns the
 * repo-convention naming (issue #39). This module keeps the title helpers
 * and the placeholder-branch discriminator that the first-rename
 * branch-follow flow depends on. `deriveTitleFromPrompt` is kept for the
 * rare case where we still accept a free-form prompt as a title source
 * (e.g. external callers via the daemon RPC).
 */

/** Title cap. Kept generous for branch slugs; the compact sidebar truncates visually. */
export const TITLE_CHAR_CAP = 40

/**
 * Placeholder title a task carries before the user (or the auto-title poller)
 * gives it a real name. SINGLE source of truth: `followBranchToTitle` decides
 * whether to keep a task's branch in lockstep with its title by re-deriving
 * this exact placeholder's branch and comparing byte-for-byte, so a second
 * private copy that drifts even one character silently breaks first-rename
 * branch-following with no compile error and no test signal. Everything that
 * needs the placeholder imports it from here.
 */
export const PLACEHOLDER_TASK_TITLE = "(new task)"

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
 * Whether `branch` is still an untouched placeholder-derived default for
 * `taskId` — the discriminator `TaskEditor.followBranchToTitle` uses to fire
 * the first-rename branch follow at most once. Three accepted shapes:
 * the convention-era `new-task` slug (optionally type-prefixed and/or
 * `-N`-suffixed, from `branch-style.ts`), and the legacy `rove/` / `kobe/`
 * `new-task-<id6>` spellings older tasks still carry.
 */
export function isPlaceholderDerivedBranch(branch: string, taskId: string): boolean {
  const id6 = taskId.slice(-6).toLowerCase()
  if (branch === `rove/new-task-${id6}` || branch === `kobe/new-task-${id6}`) return true
  return /^(?:[^/]+\/)?new-task(?:-\d+)?$/.test(branch)
}
