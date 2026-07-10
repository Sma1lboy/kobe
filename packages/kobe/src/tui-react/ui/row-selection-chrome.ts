/**
 * Shared row-selection semantics for navigation panes.
 *
 * Pane focus belongs to the pane frame (`focusAccent`). Rows deliberately
 * stay neutral: the movable keyboard cursor gets the strongest local marker
 * and tint, while a persistent selection remains visible after the cursor
 * moves without pretending the pane owns global focus.
 */

import type { Theme } from "../context/theme"

export type RowSelectionState = {
  readonly cursor: boolean
  readonly selected?: boolean
}

export function resolveRowSelectionChrome(theme: Theme, state: RowSelectionState) {
  if (state.cursor) {
    return {
      marker: "▌" as const,
      markerColor: theme.text,
      backgroundColor: theme.backgroundElement,
    }
  }
  if (state.selected) {
    return {
      marker: "▌" as const,
      markerColor: theme.borderActive,
      backgroundColor: theme.background,
    }
  }
  return {
    marker: " " as const,
    markerColor: undefined,
    backgroundColor: undefined,
  }
}
