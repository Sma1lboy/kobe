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

/** Exact, allocation-light proof that xterm's dirty rows still render to the published snapshot. */
export function dirtyRowsMatchSnapshot(
  active: ActiveBufferLike,
  snapshot: readonly TerminalRow[],
  previousMeta: SnapshotMeta | null,
  currentMeta: SnapshotMeta,
  dirty: DirtyRows | null,
  cursorHidden: boolean,
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
