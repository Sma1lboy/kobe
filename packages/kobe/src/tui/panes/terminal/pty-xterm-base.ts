/**
 * Shared xterm-headless emulation for PTY backends.
 *
 * `BunTerminalTaskPty` (local child) and `DaemonTaskPty` (daemon-hosted
 * child, protocol v4) differ ONLY in transport — where raw bytes come from
 * and where input/resize/kill go. Everything VT lives here once: the
 * headless emulator, the query-reply channel, title tracking, snapshot
 * refresh with synchronized-output handling, wheel/paste encoding.
 *
 * Subclass contract: call {@link feed} with raw child output, implement
 * the three `transport*` hooks, and call {@link markDead} when the child
 * ends. Transport hooks may throw — callers here wrap them and degrade to
 * `markDead`, matching the old Bun backend's behavior.
 */

import { Terminal as XtermHeadless } from "@xterm/headless"
import {
  type CursorPos,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type DataListener,
  type TaskPtyLike,
  type TaskPtyOpts,
  type TerminalRow,
  VISIBLE_SCROLLBACK_MARGIN_ROWS,
} from "./pty-types"
import { xtermLineToChunks } from "./xterm-chunks"

export abstract class XtermTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  protected readonly term: XtermHeadless
  private readonly listeners = new Set<DataListener>()
  private readonly exitListeners = new Set<() => void>()
  private readonly titleListeners = new Set<(title: string) => void>()
  private snapshot: readonly TerminalRow[] = []
  private cursor: CursorPos | null = null
  private _title: string | null = null
  private _killed = false
  protected cols: number
  protected rows: number
  private refreshQueued = false

  constructor(opts: TaskPtyOpts) {
    this.taskId = opts.taskId
    this.cwd = opts.cwd
    this.cols = opts.cols ?? DEFAULT_COLS
    this.rows = opts.rows ?? DEFAULT_ROWS
    this.term = new XtermHeadless({
      allowProposedApi: true,
      cols: this.cols,
      rows: this.rows,
      scrollback: VISIBLE_SCROLLBACK_MARGIN_ROWS,
    })

    // Reply channel: xterm emits responses to the program's terminal
    // queries (Primary DA `\x1b[c`, cursor-position report `\x1b[6n`,
    // status DSR, etc.) via `onData`. These MUST flow back to the
    // child's stdin — an interactive app like `claude` queries the
    // terminal on startup to detect its type/capabilities and to sync
    // its cursor model. Dropping the replies left claude on a fallback
    // path whose relative cursor-move + erase-to-EOL redraw landed on
    // the wrong rows, half-erasing its input-box rule.
    this.term.onData((data) => {
      if (this._killed) return
      try {
        this.transportWrite(data)
      } catch {
        /* best effort — child may have exited */
      }
    })

    // Window-title tracking (OSC 0/2) — xterm-headless already parses
    // these escapes internally, so the split-leaf corner tag can show
    // "vim"/"htop"/whatever's actually running instead of a static
    // "shell" (see `terminal-tabs-core.ts`'s `splitLeafNames`).
    this.term.onTitleChange((title) => {
      if (!title || title === this._title) return
      this._title = title
      for (const cb of this.titleListeners) {
        try {
          cb(title)
        } catch {
          /* one listener must not break the others */
        }
      }
    })
  }

  /** Send input bytes to the child over this backend's transport. */
  protected abstract transportWrite(data: string): void
  /** Propagate a resize to the child's PTY. */
  protected abstract transportResize(cols: number, rows: number): void
  /** End the child (kill()-path only — never called on observed exits). */
  protected abstract transportKill(): void

  get killed(): boolean {
    return this._killed
  }

  write(data: string): void {
    if (this._killed || data.length === 0) return
    try {
      this.transportWrite(data)
    } catch {
      this.markDead(false)
    }
  }

  onExit(cb: () => void): () => void {
    if (this._killed) {
      cb()
      return () => {}
    }
    this.exitListeners.add(cb)
    return () => {
      this.exitListeners.delete(cb)
    }
  }

  onTitleChange(cb: (title: string) => void): () => void {
    this.titleListeners.add(cb)
    if (this._title) {
      try {
        cb(this._title)
      } catch {
        /* one listener must not break the others */
      }
    }
    return () => {
      this.titleListeners.delete(cb)
    }
  }

  paste(text: string): void {
    if (this._killed || text.length === 0) return
    let bracketed = false
    try {
      bracketed = this.term.modes.bracketedPasteMode === true
    } catch {
      /* mode probe is best-effort */
    }
    this.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text)
  }

  wheel(direction: "up" | "down", col: number, row: number): boolean {
    if (this._killed) return false
    try {
      const modes = this.term.modes
      if (modes.mouseTrackingMode !== "none") {
        // SGR (1006) wheel encoding — xterm.js doesn't expose which
        // encoding the app negotiated, and every current TUI (claude,
        // vim, less with --mouse) requests SGR, so it's assumed.
        const btn = direction === "up" ? 64 : 65
        this.write(`\x1b[<${btn};${Math.max(1, col)};${Math.max(1, row)}M`)
        return true
      }
      if (this.term.buffer.active.type === "alternate") {
        // Fullscreen app without mouse reporting: the classic emulator
        // fallback of 3 arrow keys per wheel tick.
        const arrow =
          modes.applicationCursorKeysMode === true
            ? direction === "up"
              ? "\x1bOA"
              : "\x1bOB"
            : direction === "up"
              ? "\x1b[A"
              : "\x1b[B"
        this.write(arrow.repeat(3))
        return true
      }
    } catch {
      /* mode probe is best-effort */
    }
    return false
  }

  onData(cb: DataListener): () => void {
    this.listeners.add(cb)
    if (this.snapshot.length > 0) {
      try {
        cb(this.snapshot, this.cursor)
      } catch {
        /* one listener must not break the others */
      }
    }
    return () => {
      this.listeners.delete(cb)
    }
  }

  resize(cols: number, rows: number): void {
    if (this._killed) return
    this.cols = cols
    this.rows = rows
    try {
      this.term.resize(cols, rows)
      this.transportResize(cols, rows)
      this.refreshSnapshot()
    } catch {
      this.markDead(false)
    }
  }

  capture(): readonly TerminalRow[] {
    return this.snapshot
  }

  captureCursor(): CursorPos | null {
    return this.cursor
  }

  kill(): void {
    if (this._killed) return
    this.markDead(true)
  }

  /** Hand raw child output to xterm. Bytes, not decoded strings: xterm's
   * parser keeps a streaming UTF-8 decoder across `write` calls, so a
   * multi-byte glyph (box-drawing `─`, claude's status icons) split across
   * a chunk boundary is reassembled correctly. Decoding each chunk here
   * instead corrupted any glyph straddling a boundary. */
  protected feed(data: string | Uint8Array): void {
    if (this._killed) return
    this.term.write(data, () => this.queueRefresh())
  }

  private queueRefresh(): void {
    if (this.refreshQueued) return
    this.refreshQueued = true
    setTimeout(() => {
      this.refreshQueued = false
      this.refreshSnapshot()
    }, 16)
  }

  /**
   * Is xterm currently mid-`?2026` synchronized-output block? Apps that
   * paint atomically (interactive `claude` opens ~45 of these per
   * prompt) write a frame in two halves; snapshotting between them
   * renders a torn intermediate state. We skip the refresh while the
   * mode is set — the closing `?2026l` is itself a write that re-queues
   * a refresh once the frame is whole.
   */
  private inSynchronizedOutput(): boolean {
    try {
      return this.term.modes.synchronizedOutputMode === true
    } catch {
      return false
    }
  }

  /**
   * Has the app hidden the cursor via `?25l`? Streaming `claude` hides
   * the cursor while it paints; an unconditional inverse cursor cell on
   * top of that looks like a stray glyph. xterm tracks this on its
   * core service — not surfaced through the public typings, hence the
   * narrow internal reach.
   */
  private cursorHidden(): boolean {
    try {
      const core = (
        this.term as unknown as {
          _core?: { coreService?: { isCursorHidden?: boolean } }
        }
      )._core
      return core?.coreService?.isCursorHidden === true
    } catch {
      return false
    }
  }

  private refreshSnapshot(): void {
    if (this._killed) return
    // Don't snapshot a half-painted frame. Self-reschedule rather than
    // relying solely on the closing write's callback — under rapid redraws
    // a new sync block can open before that write lands, bouncing forever.
    if (this.inSynchronizedOutput()) {
      this.queueRefresh()
      return
    }
    const active = this.term.buffer.active
    const rows: TerminalRow[] = []
    const cursorY = active.baseY + active.cursorY
    const start = Math.max(0, active.length - (this.rows + VISIBLE_SCROLLBACK_MARGIN_ROWS))
    for (let y = start; y < active.length; y++) {
      const line = active.getLine(y)
      const minLast = y === cursorY ? active.cursorX - 1 : -1
      rows.push(line ? xtermLineToChunks(line, minLast) : [])
    }
    this.snapshot = rows
    // A hidden cursor (`?25l`) reports as null so the pane draws no
    // inverse cursor cell — same contract as a backend that can't
    // report a cursor at all.
    this.cursor = this.cursorHidden() ? null : { x: active.cursorX, y: active.baseY + active.cursorY - start }
    for (const cb of this.listeners) {
      try {
        cb(this.snapshot, this.cursor)
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  protected markDead(killProcess: boolean): void {
    if (this._killed) return
    this._killed = true
    if (killProcess) {
      try {
        this.transportKill()
      } catch {
        /* best effort */
      }
    }
    const exitCbs = [...this.exitListeners]
    this.listeners.clear()
    this.exitListeners.clear()
    for (const cb of exitCbs) {
      try {
        cb()
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  /**
   * Mark this handle dead WITHOUT firing exit listeners or touching the
   * child — the detach path (app teardown wants the daemon-hosted child
   * to keep running, and must not trigger dead-shell UI reactions
   * mid-teardown). Local-only backends fall back to kill().
   */
  protected silentDispose(): void {
    this._killed = true
    this.listeners.clear()
    this.exitListeners.clear()
    this.titleListeners.clear()
  }
}
