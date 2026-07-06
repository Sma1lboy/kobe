import { truncateEnd } from "../../lib/truncate"

/**
 * Truncate a task title to a cell budget with a trailing ellipsis. Keeps the
 * prefix unconditionally because a title's front carries the most meaning.
 * Thin alias over the shared {@link truncateEnd} owner.
 */
export function truncateTitle(title: string, max: number): string {
  return truncateEnd(title, max)
}

/**
 * Render the primary row label with a non-shrinkable spacer after the glyph.
 * Yoga may compress flex `gap` under a narrow tmux pane; making the spacer part
 * of the text keeps `★ repo` / `⠹ task` visually consistent at every width.
 */
export function spacedTitle(title: string, max: number): string {
  return ` ${truncateTitle(title, Math.max(0, max))}`
}
