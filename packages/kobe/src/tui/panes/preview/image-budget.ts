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

/**
 * chafa's default font ratio is `1/2` — it assumes each terminal cell
 * is twice as tall as wide. Windows Terminal, kitty, iTerm2, GNOME
 * Terminal all default to fonts near this ratio. If the user runs a
 * very different font we'd want to detect it via CSI 14 t, but that
 * pulls in a stdin handshake that fights opentui's own init — punt
 * for now.
 */
const CHAFA_FONT_RATIO = 0.5

/**
 * Predict the cell footprint chafa will actually fill when handed an
 * image of `dims` pixels at a `(maxCols × maxRows)` cell budget.
 *
 * chafa preserves the source aspect ratio, so it shrinks one axis to
 * fit. The reverse calculation: convert the cell budget into a
 * font-ratio-aware pixel rectangle, scale-fit the source into that
 * rectangle, then convert back to cells. Used by the sixel path so
 * the renderable claims only the cells the rendered image occupies,
 * not the full budget rectangle (which would surround the image with
 * a too-large black margin).
 */
export function fitImageToBudget(
  dims: { width: number; height: number },
  maxCols: number,
  maxRows: number,
): { cols: number; rows: number } {
  if (dims.width <= 0 || dims.height <= 0) return { cols: maxCols, rows: maxRows }
  // Pixel rectangle implied by the cell budget (1 cell-width = 1 unit,
  // 1 cell-height = 1 / CHAFA_FONT_RATIO units).
  const budgetWidth = maxCols
  const budgetHeight = maxRows / CHAFA_FONT_RATIO
  const scale = Math.min(budgetWidth / dims.width, budgetHeight / dims.height)
  const fittedWidth = dims.width * scale
  const fittedHeight = dims.height * scale
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(fittedWidth)))
  const rows = Math.max(1, Math.min(maxRows, Math.ceil(fittedHeight * CHAFA_FONT_RATIO)))
  return { cols, rows }
}
