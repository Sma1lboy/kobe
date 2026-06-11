/**
 * Pure builders for command-palette entries — data only (no run closures), so
 * the labels/ids/order are unit-testable away from the React component, which
 * maps these to runnable Commands.
 */

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
