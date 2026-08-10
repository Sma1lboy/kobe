/**
 * Shared row-selection semantics for navigation panes.
 *
 * Pane focus belongs to the pane frame (`focusAccent`). Rows deliberately
 * stay neutral: the movable keyboard cursor gets the strongest local marker
 * and tint, while a persistent selection remains visible after the cursor
 * moves without pretending the pane owns global focus.
 *
 * Transparent mode (owner call 2026-08-09): NO background fill at all — an
 * opaque tint block on top of the host wallpaper reads as a mismatched
 * patch, so the cursor signal moves entirely into the ▌ marker, which takes
 * the focus accent to stay visible against any wallpaper. Detected off the
 * resolved theme itself (`applyDisplayOverlay` zeroes `background`'s alpha),
 * so no caller has to thread the toggle through.
 */

import type { Theme } from "../context/theme"

export type RowSelectionState = {
  readonly cursor: boolean
  readonly selected?: boolean
}

export function resolveRowSelectionChrome(theme: Theme, state: RowSelectionState) {
  const transparent = theme.background.a === 0
  if (state.cursor) {
    if (transparent) {
      return {
        marker: "▌" as const,
        markerColor: theme.focusAccent ?? theme.primary,
        backgroundColor: undefined,
      }
    }
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
      backgroundColor: transparent ? undefined : theme.background,
    }
  }
  return {
    marker: " " as const,
    markerColor: undefined,
    backgroundColor: undefined,
  }
}
