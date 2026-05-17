/**
 * Compute the half-block image budget that scales with the terminal
 * size for the preview pane.
 *
 * The preview pane shares the row with the sidebar (42 cells) and the
 * file tree (38 cells, FILETREE_WIDTH in `filetree/FileTree.tsx`).
 * Whatever's left is the center column, minus a few cells for padding
 * around the card. Vertically we reserve roughly half the terminal —
 * the chat panel below the workspace and the metadata-card lines need
 * to stay readable, and an image that scrolls off-screen defeats the
 * point of an inline preview.
 *
 * Falls back to a conservative fixed budget when stdout isn't a TTY
 * (the test runner most commonly).
 */

const SIDEBAR_RESERVED_COLS = 42
const FILETREE_RESERVED_COLS = 38
const PANE_PADDING_COLS = 6
const PANE_HEADROOM_ROWS = 14

export function computeImageBudget(): { maxCols: number; maxRows: number } {
  const out = process.stdout as { columns?: number; rows?: number }
  const termCols = typeof out.columns === "number" && out.columns > 0 ? out.columns : 120
  const termRows = typeof out.rows === "number" && out.rows > 0 ? out.rows : 40
  const maxCols = Math.max(20, termCols - SIDEBAR_RESERVED_COLS - FILETREE_RESERVED_COLS - PANE_PADDING_COLS)
  const maxRows = Math.max(10, Math.floor((termRows - PANE_HEADROOM_ROWS) / 2))
  return { maxCols, maxRows }
}
