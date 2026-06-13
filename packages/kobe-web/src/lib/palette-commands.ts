/**
 * Pure builders for command-palette entries — data only (no run closures), so
 * the labels/ids/order are unit-testable away from the React component, which
 * maps these to runnable Commands.
 */

import type { Task } from "./types.ts"

/**
 * Palette task order: non-archived tasks, most-recently-updated first (stable
 * id tiebreak). Selecting a task bumps its updatedAt, so Cmd+K surfaces the
 * task you were just in near the top. Flat — no project/pinned grouping, since
 * the palette is a flat fuzzy launcher, not the grouped rail.
 */
export function orderTasksForPalette(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => !task.archived)
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt || a.createdAt) || 0
      const bt = Date.parse(b.updatedAt || b.createdAt) || 0
      return bt !== at ? bt - at : b.id.localeCompare(a.id)
    })
}

export interface ThemeCommandEntry {
  id: string
  /** "Theme: <name>" — what the palette shows + fuzzy-matches. */
  label: string
  /** "active" for the current theme, else "theme". */
  hint: string
  /** The theme name to apply via setPreferredTheme. */
  name: string
}

/** One palette entry per available theme, flagging the active one so the user
 *  can switch themes from Cmd+K. */
export function themeCommandEntries(
  names: readonly string[],
  active: string | null,
): ThemeCommandEntry[] {
  return names.map((name) => ({
    id: `theme:${name}`,
    label: `Theme: ${name}`,
    hint: name === active ? "active" : "theme",
    name,
  }))
}
