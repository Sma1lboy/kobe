import type { Terminal as XtermHeadless } from "@xterm/headless"
import type { TerminalRow } from "./pty-types"
import { type XtermLineLike, xtermLineMatchesChunks } from "./xterm-chunks"

/**
 * Wire the two outbound xterm channels every backend needs:
 *   - the query-reply channel (`onData`): xterm's answers to the child's
 *     terminal queries (Primary DA `\x1b[c`, CPR `\x1b[6n`, DSR…) MUST flow
 *     back to the child's stdin — interactive engines probe the terminal on
 *     startup and fall onto broken redraw paths without the replies;
 *   - window-title tracking (`onTitleChange`, OSC 0/2): the tab strip shows
 *     the live foreground-process name instead of a static "shell".
 */
export function wireXtermChannels(
  term: XtermHeadless,
  hooks: { onReply(data: string): void; onTitle(title: string): void },
): void {
  term.onData(hooks.onReply)
  term.onTitleChange(hooks.onTitle)
}

export type SnapshotMeta = {
  type: "normal" | "alternate"
  baseY: number
  length: number
  start: number
}

type DirtyRows = { kind: "all" } | { kind: "range"; start: number; end: number }
type Disposable = { dispose(): void }

type ActiveBufferLike = {
  type: "normal" | "alternate"
  baseY: number
  cursorX: number
  cursorY: number
  length: number
  getLine(index: number): XtermLineLike | undefined
}

/** Narrow adapter around xterm's internal dirty-row event; unsupported versions safely fall back to full checks. */
export class XtermRefreshTracker {
  private dirty: DirtyRows | null = null
  private readonly subscription: Disposable | null
  readonly supported: boolean

  constructor(term: XtermHeadless) {
    const event = (
      term as unknown as {
        _core?: {
          _inputHandler?: {
            onRequestRefreshRows?: (listener: (range: { start: number; end: number } | undefined) => void) => Disposable
          }
        }
      }
    )._core?._inputHandler?.onRequestRefreshRows
    if (!event) {
      this.supported = false
      this.subscription = null
      return
    }
    this.supported = true
    this.subscription = event((range) => {
      if (!range) {
        this.dirty = { kind: "all" }
        return
      }
      if (!this.dirty) this.dirty = { kind: "range", start: range.start, end: range.end }
      else if (this.dirty.kind === "range") {
        this.dirty.start = Math.min(this.dirty.start, range.start)
        this.dirty.end = Math.max(this.dirty.end, range.end)
      }
    })
  }

  markAll(): void {
    this.dirty = { kind: "all" }
  }

  peek(): DirtyRows | null {
    return this.dirty
  }

  clear(): void {
    this.dirty = null
  }

  dispose(): void {
    this.subscription?.dispose()
  }
}

export function snapshotMeta(active: ActiveBufferLike, viewportRows: number, scrollbackRows: number): SnapshotMeta {
  return {
    type: active.type,
    baseY: active.baseY,
    length: active.length,
    start: Math.max(0, active.length - (viewportRows + scrollbackRows)),
  }
}

function sameMeta(a: SnapshotMeta, b: SnapshotMeta): boolean {
  return a.type === b.type && a.baseY === b.baseY && a.length === b.length && a.start === b.start
}

/**
 * The rebuild path's absolute-id view of frozen scrollback, handed to the
 * verify path so it can skip rows that provably cannot have changed.
 *
 * Why this is needed: a synchronized-output engine (DECSET 2026 — which is
 * what claude and codex actually emit) closes every frame with a refresh
 * event carrying no range, which lands here as `{kind:"all"}`. With dirty=ALL
 * the loop below has no range to narrow to, so it re-verified the ENTIRE
 * window — viewport plus up to `scrollbackRows` frozen rows — on every single
 * refresh, both when the frame changed and when it didn't. At the default
 * 1000-row scrollback that measured 0.63ms per refresh proving nothing had
 * changed (3.9% of a core against the 62.5Hz coalesce cap), and it is paid
 * BEFORE reaching the viewport rows that actually differ, so streaming frames
 * pay it too.
 */
export interface FrozenScrollback {
  /** Rows below this index have scrolled out of the viewport. */
  readonly baseY: number
  /** Offset turning a buffer index into the anchor-relative absolute line id. */
  readonly absBase: number
  /** The rebuild path's absolute-id -> row cache. */
  readonly cache: ReadonlyMap<number, TerminalRow>
}

/** Exact, allocation-light proof that xterm's dirty rows still render to the published snapshot. */
export function dirtyRowsMatchSnapshot(
  active: ActiveBufferLike,
  snapshot: readonly TerminalRow[],
  previousMeta: SnapshotMeta | null,
  currentMeta: SnapshotMeta,
  dirty: DirtyRows | null,
  cursorHidden: boolean,
  frozen: FrozenScrollback | null = null,
): boolean {
  if (!previousMeta || !sameMeta(previousMeta, currentMeta) || !dirty) return false
  let first = currentMeta.start
  let last = currentMeta.length - 1
  if (dirty.kind === "range") {
    first = Math.max(first, active.baseY + dirty.start)
    last = Math.min(last, active.baseY + dirty.end)
  }
  const cursorY = active.baseY + active.cursorY
  for (let y = first; y <= last; y++) {
    const row = snapshot[y - currentMeta.start]
    if (!row) return false
    // xterm never edits a line that has scrolled out of the viewport — it
    // only trims from the top or appends at the bottom. So a frozen row the
    // rebuild path already cached under its ABSOLUTE line id cannot have
    // changed in place, and re-deriving it from the buffer is pure waste.
    //
    // The identity compare is what keeps this sound across a shift: in a
    // saturated buffer `baseY`/`length`/`start` all stay constant while
    // content scrolls, so `sameMeta` above cannot see the move. But the
    // absolute id -> snapshot index mapping DOES move, so `cache.get()`
    // returns some other row (or nothing) and the compare fails, dropping us
    // into the full rebuild that re-derives the shifted window. That is the
    // same anchor the rebuild loop trusts, so the two paths agree by
    // construction.
    if (frozen && y < frozen.baseY && frozen.cache.get(frozen.absBase + y) === row) continue
    const minLast = !cursorHidden && y === cursorY ? active.cursorX - 1 : -1
    if (!xtermLineMatchesChunks(active.getLine(y), row, minLast)) return false
  }
  return true
}

export function xtermSynchronizedOutput(term: XtermHeadless): boolean {
  try {
    return term.modes.synchronizedOutputMode === true
  } catch {
    return false
  }
}

export function xtermCursorHidden(term: XtermHeadless): boolean {
  try {
    return (
      (
        term as unknown as {
          _core?: { coreService?: { isCursorHidden?: boolean } }
        }
      )._core?.coreService?.isCursorHidden === true
    )
  } catch {
    return false
  }
}
