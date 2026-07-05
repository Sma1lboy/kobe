/**
 * Terminal pane process abstraction.
 *
 * kobe deliberately does NOT use tmux here anymore. The default backend
 * uses Bun's native PTY support (`Bun.spawn(..., { terminal })`) and a
 * headless xterm emulator to turn terminal control bytes into a stable
 * screen buffer for opentui to render.
 *
 * The Bun backend renders xterm's authoritative cell grid DIRECTLY into
 * opentui-ready style runs (`Chunk[]` per row) — we do not re-serialize
 * cells back to ANSI and re-parse them. xterm-headless owns the VT
 * emulation end to end; this file only maps its cells to chunks. (The
 * old cell→ANSI→reparse round-trip was where every render bug lived:
 * true-color SGR mis-parsing, multi-byte glyph corruption. KOB-224.)
 *
 * A pipe backend remains available through `KOBE_TERMINAL_BACKEND=pipe`
 * as a fallback for old Bun builds or unsupported platforms. It has no
 * emulator, so it still parses its raw byte buffer via `sgr.ts` into the
 * same `Chunk[]` rows.
 */

import { Terminal as XtermHeadless } from "@xterm/headless"
import { MockTaskPty } from "./pty-mock"
import { PipeTaskPty } from "./pty-pipe"
import {
  type CursorPos,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type DataListener,
  type TaskPtyLike,
  type TaskPtyOpts,
  type TerminalRow,
  VISIBLE_SCROLLBACK_MARGIN_ROWS,
  resolveArgv,
} from "./pty-types"
import { xtermLineToChunks } from "./xterm-chunks"

export { MockTaskPty } from "./pty-mock"
export { PipeTaskPty } from "./pty-pipe"
export type { CursorPos, DataListener, TaskPtyLike, TaskPtyOpts, TerminalRow } from "./pty-types"

/* --------------------------------------------------------------------- */
/*  Bun PTY backend                                                       */
/* --------------------------------------------------------------------- */

export class BunTerminalTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly proc: ReturnType<typeof Bun.spawn>
  private readonly term: XtermHeadless
  private readonly listeners = new Set<DataListener>()
  private snapshot: readonly TerminalRow[] = []
  private cursor: CursorPos | null = null
  private _killed = false
  private cols: number
  private rows: number
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
    // the wrong rows, half-erasing its input-box rule (KOB-208).
    this.term.onData((data) => {
      if (this._killed) return
      try {
        this.proc.terminal?.write(data)
      } catch {
        /* best effort — child may have exited */
      }
    })

    this.proc = Bun.spawn(resolveArgv(opts), {
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
        BASH_SILENCE_DEPRECATION_WARNING: "1",
        KOBE_TERMINAL_PTY: "1",
      },
      terminal: {
        cols: this.cols,
        rows: this.rows,
        name: "xterm-256color",
        data: (_terminal, data) => this.onTerminalData(data),
        exit: () => this.markDead(false),
      },
    })
    void this.proc.exited.then(
      () => this.markDead(false),
      () => this.markDead(false),
    )
    this.proc.unref?.()
  }

  get killed(): boolean {
    return this._killed
  }

  write(data: string): void {
    if (this._killed || data.length === 0) return
    try {
      this.proc.terminal?.write(data)
    } catch {
      this.markDead(false)
    }
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
      this.proc.terminal?.resize(cols, rows)
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

  private onTerminalData(data: string | Uint8Array): void {
    if (this._killed) return
    // Hand raw bytes straight to xterm. Its parser keeps a streaming
    // UTF-8 decoder across `write` calls, so a multi-byte glyph
    // (box-drawing `─`, claude's status icons) split across a PTY chunk
    // boundary is reassembled correctly. Decoding each chunk to a UTF-8
    // string here instead corrupted any glyph straddling a boundary:
    // claude's full-width input-box rule rendered with gaps and its
    // relative-cursor redraw landed on the wrong row (KOB-208).
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
    // Don't snapshot a half-painted frame — wait for the sync block to close.
    if (this.inSynchronizedOutput()) return
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

  private markDead(killProcess: boolean): void {
    if (this._killed) return
    this._killed = true
    if (killProcess) {
      try {
        this.proc.terminal?.close()
      } catch {
        /* best effort */
      }
      try {
        this.proc.kill("SIGTERM")
      } catch {
        /* best effort */
      }
    }
    this.listeners.clear()
  }
}

/* --------------------------------------------------------------------- */
/*  Backend selection                                                     */
/* --------------------------------------------------------------------- */

export function createTaskPty(opts: TaskPtyOpts): TaskPtyLike {
  const backend = process.env.KOBE_TERMINAL_BACKEND ?? "bun-pty"
  if (backend === "mock") return new MockTaskPty(opts)
  if (backend === "pipe") return new PipeTaskPty(opts)
  if (backend === "bun-pty") return new BunTerminalTaskPty(opts)
  throw new Error(`unknown terminal backend: ${backend}`)
}

export type TaskPty = TaskPtyLike
