import {
  type CursorPos,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type DataListener,
  type TaskPtyLike,
  type TaskPtyOpts,
  type TerminalRow,
  extractOscTitle,
} from "./pty-types"
import { parseAnsiSnapshot } from "./sgr"

export class MockTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly listeners = new Set<DataListener>()
  private buffer = ""
  private writes: string[] = []
  private _killed = false
  private _title: string | null = null
  private readonly exitListeners = new Set<() => void>()
  private readonly titleListeners = new Set<(title: string) => void>()
  /** Pasted payloads, observable by tests. */
  readonly pastes: string[] = []
  readonly wheels: { direction: "up" | "down"; col: number; row: number }[] = []
  private _cols: number
  private _rows: number
  private _cursor: CursorPos | null = null

  constructor(opts: TaskPtyOpts) {
    this.taskId = opts.taskId
    this.cwd = opts.cwd
    this._cols = opts.cols ?? DEFAULT_COLS
    this._rows = opts.rows ?? DEFAULT_ROWS
  }

  get killed(): boolean {
    return this._killed
  }

  get writeLog(): readonly string[] {
    return this.writes
  }

  get geometry(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows }
  }

  feed(data: string): void {
    if (this._killed) return
    this.buffer += data
    const title = extractOscTitle(data)
    if (title && title !== this._title) {
      this._title = title
      for (const cb of this.titleListeners) {
        try {
          cb(title)
        } catch {
          /* one listener must not break the others */
        }
      }
    }
    const rows = this.capture()
    for (const cb of this.listeners) {
      try {
        cb(rows, this._cursor)
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  write(data: string): void {
    if (this._killed) return
    this.writes.push(data)
  }

  onData(cb: DataListener): () => void {
    this.listeners.add(cb)
    if (this.buffer !== "") {
      try {
        cb(this.capture(), this._cursor)
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
    this._cols = cols
    this._rows = rows
  }

  capture(): readonly TerminalRow[] {
    // Tests `feed()` raw ANSI/text; expose it as the same parsed rows
    // the production backends emit.
    return parseAnsiSnapshot(this.buffer)
  }

  setCursor(pos: CursorPos | null): void {
    this._cursor = pos
  }

  captureCursor(): CursorPos | null {
    if (this._killed) return null
    return this._cursor
  }

  kill(): void {
    if (this._killed) return
    this._killed = true
    this.listeners.clear()
    const exitCbs = [...this.exitListeners]
    this.exitListeners.clear()
    for (const cb of exitCbs) cb()
  }

  paste(text: string): void {
    if (this._killed) return
    this.pastes.push(text)
  }

  wheel(direction: "up" | "down", col: number, row: number): boolean {
    if (this._killed) return false
    this.wheels.push({ direction, col, row })
    return false
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
}
