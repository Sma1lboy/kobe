/**
 * Terminal progress glyphs. The partial-block vocabulary is lifted from
 * Claude Code's design-system ProgressBar (refs/claude-code
 * `src/components/design-system/ProgressBar.tsx`); kobe currently ships
 * only the INDETERMINATE form — a comet sweeping a fixed-width track —
 * because the one long-job consumer (worktree materializing) has no ratio
 * to render. Add the determinate ratio→blocks form when a real ratio
 * consumer appears.
 */

/** Comet profile, head-first: full block, then two tapering tails. */
const COMET = ["█", "▋", "▍"] as const

export const SWEEP_WIDTH = 8

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
