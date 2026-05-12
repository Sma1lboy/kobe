/**
 * Terminal pane process abstraction.
 *
 * kobe deliberately does NOT use tmux here anymore. The terminal pane
 * starts one shell process per task and connects stdin/stdout/stderr
 * through ordinary pipes. That keeps the implementation small and
 * avoids tmux session/control-mode bugs.
 *
 * Tradeoff: this is not a real PTY. Ordinary shell commands work, but
 * full-screen TTY programs (`vim`, `htop`, interactive `claude`) may
 * degrade or refuse because stdout is not a terminal. A future pass can
 * add a real PTY through a Bun-compatible PTY library; tmux is not the
 * fallback.
 */

import { spawn } from "node:child_process"

/* --------------------------------------------------------------------- */
/*  Public surface                                                        */
/* --------------------------------------------------------------------- */

export type TaskPtyOpts = {
  /** Working directory the shell should start in. Required. */
  cwd: string
  /** Stable id used by the registry. Required. */
  taskId: string
  /** Initial pane size. Default 80x24. */
  cols?: number
  /** Initial pane size. Default 80x24. */
  rows?: number
  /** Override `$SHELL`. Defaults to `process.env.SHELL` or `/bin/bash`. */
  shell?: string
}

/** Listener for new pane snapshots. Receives the full buffer. */
export type DataListener = (snapshot: string, cursor: CursorPos | null) => void

/** Cursor position within the visible pane, 0-based. Pipe backend cannot report it. */
export type CursorPos = { x: number; y: number }

export interface TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  readonly killed: boolean

  write(data: string): void
  onData(cb: DataListener): () => void
  resize(cols: number, rows: number): void
  capture(): string
  captureCursor(): CursorPos | null
  kill(): void
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const PIPE_SCROLLBACK_LIMIT = 200_000

function defaultShell(): string {
  return process.env.SHELL ?? "/bin/bash"
}

function shellArgs(shell: string): string[] {
  const base = shell.split("/").pop() ?? shell
  if (base.includes("bash") || base.includes("zsh") || base.includes("fish")) return ["-i"]
  return []
}

/* --------------------------------------------------------------------- */
/*  Pipe backend                                                          */
/* --------------------------------------------------------------------- */

export class PipeTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly proc: ReturnType<typeof spawn>
  private readonly listeners = new Set<DataListener>()
  private buffer = ""
  private _killed = false
  private cols: number
  private rows: number

  constructor(opts: TaskPtyOpts) {
    this.taskId = opts.taskId
    this.cwd = opts.cwd
    this.cols = opts.cols ?? DEFAULT_COLS
    this.rows = opts.rows ?? DEFAULT_ROWS

    const shell = opts.shell ?? defaultShell()
    this.proc = spawn(shell, shellArgs(shell), {
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM ?? "xterm-256color",
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
        KOBE_TERMINAL_PIPE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    this.proc.stdout?.setEncoding("utf8")
    this.proc.stderr?.setEncoding("utf8")
    this.proc.stdout?.on("data", (chunk: string) => this.append(chunk))
    this.proc.stderr?.on("data", (chunk: string) => this.append(chunk))
    this.proc.stdin?.on("error", () => this.markDead(false))
    this.proc.on("error", (err) => {
      this.append(`\n[kobe terminal] failed to start shell: ${err.message}\n`)
      this.markDead(false)
    })
    this.proc.on("exit", () => this.markDead(false))
    this.proc.unref?.()
  }

  get killed(): boolean {
    return this._killed
  }

  write(data: string): void {
    if (this._killed || data.length === 0) return
    const stdin = this.proc.stdin
    if (!stdin || stdin.destroyed) return
    // Pipes are not terminal line disciplines. Translate Enter's CR
    // into LF so shells read the command.
    const bytes = data.replace(/\r/g, "\n")
    try {
      stdin.write(bytes)
    } catch {
      this.markDead(false)
    }
  }

  onData(cb: DataListener): () => void {
    this.listeners.add(cb)
    if (this.buffer !== "") {
      try {
        cb(this.buffer, null)
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
    // No PTY means no SIGWINCH-compatible resize channel. Keep the
    // latest geometry for future process restarts.
  }

  capture(): string {
    return this.buffer
  }

  captureCursor(): CursorPos | null {
    return null
  }

  kill(): void {
    if (this._killed) return
    this.markDead(true)
  }

  private append(chunk: string): void {
    if (this._killed) return
    this.buffer += chunk
    if (this.buffer.length > PIPE_SCROLLBACK_LIMIT) {
      this.buffer = this.buffer.slice(this.buffer.length - PIPE_SCROLLBACK_LIMIT)
    }
    for (const cb of this.listeners) {
      try {
        cb(this.buffer, null)
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
        this.proc.kill("SIGTERM")
      } catch {
        /* best effort */
      }
    }
    this.listeners.clear()
  }
}

/* --------------------------------------------------------------------- */
/*  Mock backend (tests only)                                             */
/* --------------------------------------------------------------------- */

export class MockTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly listeners = new Set<DataListener>()
  private buffer = ""
  private writes: string[] = []
  private _killed = false
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
    for (const cb of this.listeners) {
      try {
        cb(this.buffer, this._cursor)
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
        cb(this.buffer, this._cursor)
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

  capture(): string {
    return this.buffer
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
  }
}

/* --------------------------------------------------------------------- */
/*  Backend selection                                                     */
/* --------------------------------------------------------------------- */

export function createTaskPty(opts: TaskPtyOpts): TaskPtyLike {
  const backend = process.env.KOBE_TERMINAL_BACKEND ?? "pipe"
  if (backend === "mock") return new MockTaskPty(opts)
  return new PipeTaskPty(opts)
}

export type TaskPty = TaskPtyLike
