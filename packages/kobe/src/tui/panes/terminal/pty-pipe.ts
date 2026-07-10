import { spawn } from "node:child_process"
import { embeddedTerminalEnv } from "@sma1lboy/kobe-daemon/daemon/pty-env"
import {
  type CursorPos,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type DataListener,
  PIPE_SCROLLBACK_LIMIT,
  type TaskPtyLike,
  type TaskPtyOpts,
  type TerminalRow,
  defaultShell,
  extractOscTitle,
  resolveArgv,
} from "./pty-types"
import { parseAnsiSnapshot } from "./sgr"

export class PipeTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly proc: ReturnType<typeof spawn>
  private readonly listeners = new Set<DataListener>()
  private buffer = ""
  private _killed = false
  private _title: string | null = null
  private readonly exitListeners = new Set<() => void>()
  private readonly titleListeners = new Set<(title: string) => void>()
  private cols: number
  private rows: number

  constructor(opts: TaskPtyOpts) {
    this.taskId = opts.taskId
    this.cwd = opts.cwd
    this.cols = opts.cols ?? DEFAULT_COLS
    this.rows = opts.rows ?? DEFAULT_ROWS

    // Do not pass `-i`: interactive shells expect a controlling TTY for
    // job control and can suspend the host TUI when backed only by pipes.
    // A `command` override (e.g. `["claude"]`) carries its own argv.
    const argv = resolveArgv(opts)
    const exe = argv[0] ?? defaultShell()
    const args = argv.slice(1)
    this.proc = spawn(exe, args, {
      cwd: opts.cwd,
      env: embeddedTerminalEnv(process.env, {
        TERM: process.env.TERM ?? "xterm-256color",
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
        KOBE_TERMINAL_PIPE: "1",
      }),
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
    if (opts.initialInput) this.write(opts.initialInput)
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
        cb(this.capture(), null)
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

  capture(): readonly TerminalRow[] {
    // No emulator on this fallback path: parse the accumulated raw ANSI
    // into the same `Chunk[]` rows the Bun backend produces from cells.
    return parseAnsiSnapshot(this.buffer)
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
    // No emulator on this fallback path — extract OSC 0/2 title escapes
    // by hand (the Bun/xterm backend gets this from `onTitleChange`).
    const title = extractOscTitle(chunk)
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
        cb(rows, null)
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

  paste(text: string): void {
    // Pipes have no bracketed-paste negotiation — deliver raw.
    this.write(text)
  }

  wheel(): boolean {
    // No emulator state behind a pipe — the pane owns wheel scrolling.
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
