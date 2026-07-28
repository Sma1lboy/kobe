/**
 * Terminal progress glyphs. The partial-block vocabulary is lifted from
 * Claude Code's design-system ProgressBar (refs/claude-code
 * `src/components/design-system/ProgressBar.tsx`): an INDETERMINATE comet
 * sweep (worktree materializing) and a DETERMINATE ratio→blocks meter
 * (the Settings usage dashboard).
 */

/** Comet profile, head-first: full block, then two tapering tails. */
const COMET = ["█", "▋", "▍"] as const

export const SWEEP_WIDTH = 8

/** Eighth-block ramp for the determinate meter's fractional cell. */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const

/**
 * Determinate meter: `ratio` (0..1, clamped) rendered as full blocks plus
 * one eighth-block fractional cell, padded with light shade to exactly
 * `width` chars — so a row of meters aligns without a background color.
 */
export function ratioBar(ratio: number, width = SWEEP_WIDTH): string {
  const cells = Math.min(1, Math.max(0, ratio)) * width
  let full = Math.floor(cells)
  let eighth = Math.round((cells - full) * 8)
  if (eighth === 8) {
    full += 1
    eighth = 0
  }
  const partial = full < width ? (EIGHTHS[eighth] ?? "") : ""
  return `${"█".repeat(full)}${partial}`.padEnd(width, "░")
}

/**
 * One frame of the indeterminate sweep: a 3-cell comet crossing a
 * `width`-cell track left→right, fully exiting before it wraps (the
 * `+ COMET.length` overshoot), so the motion reads as repeated passes
 * rather than a loop snap. Pure — drive it with the shared 10Hz spinner
 * tick. Always returns exactly `width` chars.
 */
export function sweepBar(frame: number, width = SWEEP_WIDTH): string {
  const head = frame % (width + COMET.length)
  let out = ""
  for (let i = 0; i < width; i++) {
    const d = head - i
    out += d >= 0 && d < COMET.length ? (COMET[d] ?? " ") : " "
  }
  return out
}
