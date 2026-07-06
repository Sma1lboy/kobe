/**
 * Bounded-tail windowing for the history transcript. opentui's scrollbox only
 * culls DRAWING — every off-screen row stays a live Renderable holding native
 * Yoga nodes + Zig TextBuffers (off-JS-heap), so rendering a multi-day
 * transcript in full leaks gigabytes of RSS (observed: ~126k messages →
 * 13-22 GB). The pane therefore mounts only the last {@link RENDER_WINDOW}
 * messages and shows a one-row "… N earlier messages" indicator; session-level
 * stats (token total, tool-result index) still run over the FULL list.
 *
 * Vitest-safe: no @opentui import (see test/tui/history-window.test.ts).
 */

/** Max messages mounted in the scrollbox at once. */
export const RENDER_WINDOW = 200

export interface TailWindow<T> {
  /** Messages elided before the window (0 → no indicator row). */
  readonly hiddenCount: number
  /** The rendered tail — at most `cap` items, same order as the input. */
  readonly visible: readonly T[]
}

/** Slice `list` to its last `cap` items, reporting how many were elided. */
export function windowTail<T>(list: readonly T[], cap: number = RENDER_WINDOW): TailWindow<T> {
  if (list.length <= cap) return { hiddenCount: 0, visible: list }
  return { hiddenCount: list.length - cap, visible: list.slice(list.length - cap) }
}
