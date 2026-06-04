/**
 * Truncate a task title to a cell budget with a trailing ellipsis. Keeps the
 * prefix unconditionally because a title's front carries the most meaning.
 * Uses `.length` like the branch/path truncators; CJK wide-char accounting is a
 * known, accepted imprecision shared by these compact row labels.
 */
export function truncateTitle(title: string, max: number): string {
  if (max <= 0) return ""
  if (title.length <= max) return title
  return `${title.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Render the primary row label with a non-shrinkable spacer after the glyph.
 * Yoga may compress flex `gap` under a narrow tmux pane; making the spacer part
 * of the text keeps `★ repo` / `⠹ task` visually consistent at every width.
 */
export function spacedTitle(title: string, max: number): string {
  return ` ${truncateTitle(title, Math.max(0, max))}`
}
