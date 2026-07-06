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

export class BunTerminalTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly proc: ReturnType<typeof Bun.spawn>
  private readonly term: XtermHeadless
  private readonly listeners = new Set<DataListener>()
  private readonly exitListeners = new Set<() => void>()
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

    this.term.onData((data) => {
      if (this._killed) return
      try {
        this.proc.terminal?.write(data)
      } catch {}
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

  paste(text: string): void {
    if (this._killed || text.length === 0) return
    let bracketed = false
    try {
      bracketed = this.term.modes.bracketedPasteMode === true
    } catch {}
    this.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text)
  }

  onData(cb: DataListener): () => void {
    this.listeners.add(cb)
    if (this.snapshot.length > 0) {
      try {
        cb(this.snapshot, this.cursor)
      } catch {}
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

  private inSynchronizedOutput(): boolean {
    try {
      return this.term.modes.synchronizedOutputMode === true
    } catch {
      return false
    }
  }

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
    this.cursor = this.cursorHidden() ? null : { x: active.cursorX, y: active.baseY + active.cursorY - start }
    for (const cb of this.listeners) {
      try {
        cb(this.snapshot, this.cursor)
      } catch {}
    }
  }

  private markDead(killProcess: boolean): void {
    if (this._killed) return
    this._killed = true
    if (killProcess) {
      try {
        this.proc.terminal?.close()
      } catch {}
      try {
        this.proc.kill("SIGTERM")
      } catch {}
    }
    const exitCbs = [...this.exitListeners]
    this.listeners.clear()
    this.exitListeners.clear()
    for (const cb of exitCbs) {
      try {
        cb()
      } catch {}
    }
  }
}

export function createTaskPty(opts: TaskPtyOpts): TaskPtyLike {
  const backend = process.env.KOBE_TERMINAL_BACKEND ?? "bun-pty"
  if (backend === "mock") return new MockTaskPty(opts)
  if (backend === "pipe") return new PipeTaskPty(opts)
  if (backend === "bun-pty") return new BunTerminalTaskPty(opts)
  throw new Error(`unknown terminal backend: ${backend}`)
}

export type TaskPty = TaskPtyLike
