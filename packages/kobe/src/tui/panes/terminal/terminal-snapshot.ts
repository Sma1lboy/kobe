import type { CursorPos, TerminalRow } from "./pty-types"
import type { Chunk, RGB } from "./sgr"

function sameRgb(a: RGB | undefined, b: RGB | undefined): boolean {
  if (a === b) return true
  return a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function sameChunk(a: Chunk, b: Chunk): boolean {
  return a.text === b.text && (a.attributes ?? 0) === (b.attributes ?? 0) && sameRgb(a.fg, b.fg) && sameRgb(a.bg, b.bg)
}

function sameRow(a: TerminalRow, b: TerminalRow): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!sameChunk(a[i] as Chunk, b[i] as Chunk)) return false
  }
  return true
}

export function reconcileTerminalRow(previous: TerminalRow | undefined, next: TerminalRow): TerminalRow {
  return previous && sameRow(previous, next) ? previous : next
}

/** Preserve row and snapshot identity when xterm parsed input but the rendered cells did not change. */
export function reconcileTerminalRows(previous: readonly TerminalRow[], next: TerminalRow[]): readonly TerminalRow[] {
  if (previous.length !== next.length) return next
  let changed = false
  for (let i = 0; i < next.length; i++) {
    const stable = reconcileTerminalRow(previous[i], next[i] as TerminalRow)
    next[i] = stable
    if (stable !== previous[i]) changed = true
  }
  return changed ? next : previous
}

/** Cursor objects are recreated on every probe; retain the old reference when their visible value is unchanged. */
export function reconcileTerminalCursor(previous: CursorPos | null, next: CursorPos | null): CursorPos | null {
  if (previous === next) return previous
  if (previous && next && previous.x === next.x && previous.y === next.y) return previous
  return next
}
