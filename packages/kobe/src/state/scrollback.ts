/**
 * Terminal scrollback preference (Settings → General → Terminal).
 *
 * How many rows of history each embedded terminal's xterm buffer keeps.
 * kv-persisted; read framework-free at PTY construction
 * (`tui/panes/terminal/pty-xterm-base.ts`), so it applies to terminals
 * spawned after the change — live PTYs keep the buffer they were born
 * with (xterm reflow on live resize is not worth the churn).
 */

import { loadStateFile } from "./store"

export const SCROLLBACK_ROWS_KEY = "terminal.scrollbackRows"

export const DEFAULT_SCROLLBACK_ROWS = 1000
export const SCROLLBACK_ROWS_MIN = 100
export const SCROLLBACK_ROWS_MAX = 100_000

/** Coerce a persisted value to a sane row count (garbage → default, out-of-range → clamped). */
export function normalizeScrollbackRows(value: unknown): number {
  const n =
    typeof value === "number"
      ? Math.floor(value)
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_SCROLLBACK_ROWS
  return Math.min(SCROLLBACK_ROWS_MAX, Math.max(SCROLLBACK_ROWS_MIN, n))
}

/** Framework-free read for the PTY layer — kv writes land in the same state.json. */
export function persistedScrollbackRows(): number {
  return normalizeScrollbackRows(loadStateFile()[SCROLLBACK_ROWS_KEY])
}
