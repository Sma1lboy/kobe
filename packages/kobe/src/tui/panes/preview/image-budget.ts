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
/**
 * Fraction of the preview pane's vertical real-estate we hand to the
 * image. Going higher than ~0.75 starts to crowd the path subtitle and
 * any future metadata bar; staying at 0.5 (the original setting) made
 * the rendered sixel feel tiny on terminals where the workspace pane
 * has lots of free rows.
 */
const IMAGE_HEIGHT_FRACTION = 0.75

export function computeImageBudget(): { maxCols: number; maxRows: number } {
  const out = process.stdout as { columns?: number; rows?: number }
  const termCols = typeof out.columns === "number" && out.columns > 0 ? out.columns : 120
  const termRows = typeof out.rows === "number" && out.rows > 0 ? out.rows : 40
  const maxCols = Math.max(20, termCols - SIDEBAR_RESERVED_COLS - FILETREE_RESERVED_COLS - PANE_PADDING_COLS)
  const maxRows = Math.max(10, Math.floor((termRows - PANE_HEADROOM_ROWS) * IMAGE_HEIGHT_FRACTION))
  return { maxCols, maxRows }
}

/**
 * Approximate Windows Terminal Cascadia Mono cell pixel size at the
 * default font size. Real terminals vary (kitty / iTerm at different
 * font sizes can be ~8×16 to ~14×30), but a fixed assumption gives a
 * far better cell-footprint prediction than chafa's default font-ratio
 * 1/2 (which translates to a square 8×8 cell internally for sixel
 * sizing). Querying CSI 14 t at runtime would be more accurate but
 * fights opentui's own startup handshake.
 */
const ASSUMED_CELL_PX_W = 10
const ASSUMED_CELL_PX_H = 22

/**
 * Convert chafa's sixel pixel output to the WT-cell footprint the
 * rendered image will occupy. The pixel dims come from the sixel
 * raster attributes; we divide by the assumed cell pixel size and
 * clamp to the budget so the renderable doesn't claim more cells
 * than the preview pane reserved.
 */
export function sixelPixelsToCells(
  pixelWidth: number,
  pixelHeight: number,
  maxCols: number,
  maxRows: number,
): { cols: number; rows: number } {
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(pixelWidth / ASSUMED_CELL_PX_W)))
  const rows = Math.max(1, Math.min(maxRows, Math.ceil(pixelHeight / ASSUMED_CELL_PX_H)))
  return { cols, rows }
}
