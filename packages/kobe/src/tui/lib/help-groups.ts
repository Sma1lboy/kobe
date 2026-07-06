/**
 * Framework-free keymap grouping for the help dialog (issue #15, G3) —
 * shared by the Solid `src/tui/component/help-dialog.tsx` and the React
 * port. Generic over the `category` field so it never drags the keybinding
 * table (and its Solid signal) into unit tests.
 */

/** Group a flat keymap into categories in declaration order. */
export function groupBindings<T extends { readonly category: string }>(
  keymap: readonly T[],
): { category: string; rows: readonly T[] }[] {
  const grouped: { category: string; rows: T[] }[] = []
  const index = new Map<string, T[]>()
  for (const b of keymap) {
    let rows = index.get(b.category)
    if (!rows) {
      rows = []
      index.set(b.category, rows)
      grouped.push({ category: b.category, rows })
    }
    rows.push(b)
  }
  return grouped
}
