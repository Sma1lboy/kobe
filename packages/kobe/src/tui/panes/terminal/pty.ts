/**
 * Terminal pane process abstraction.
 *
 * kobe deliberately does NOT use tmux here anymore. The default backend
 * uses Bun's native PTY support (`Bun.spawn(..., { terminal })`) and a
 * headless xterm emulator to turn terminal control bytes into a stable
 * screen buffer for opentui to render.
 *
 * A pipe backend remains available through `KOBE_TERMINAL_BACKEND=pipe`
 * as a fallback for old Bun builds or unsupported platforms, but it is
 * not the production path.
 */

import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { Terminal as XtermHeadless } from "@xterm/headless"

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
  /**
   * Override the spawned process argv. When set, the PTY runs this
   * command instead of an interactive shell — e.g. `["claude"]` to
   * embed an interactive Claude Code session in the terminal pane.
   * The first element is the executable; the rest are its arguments.
   * When unset (or empty) the PTY falls back to the user's shell.
   */
  command?: readonly string[]
}

/** Listener for new pane snapshots. Receives the full buffer. */
export type DataListener = (snapshot: string, cursor: CursorPos | null) => void

/** Cursor position within the rendered pane, 0-based. */
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
const VISIBLE_SCROLLBACK_MARGIN_ROWS = 200
const XTERM_COLOR_MODE_DEFAULT = 0
const XTERM_COLOR_MODE_PALETTE = 1 << 24
const XTERM_COLOR_MODE_RGB = 3 << 24

function defaultShell(): string {
  return process.env.SHELL ?? "/bin/bash"
}

/**
 * Resolve the argv a `TaskPty` should spawn. Honours an explicit
 * `command` override (the `["claude"]` interactive-engine path used by
 * the chat pane) and otherwise falls back to a single-element shell
 * argv — the terminal pane's default.
 */
function resolveArgv(opts: TaskPtyOpts): string[] {
  if (opts.command && opts.command.length > 0) return [...opts.command]
  return [opts.shell ?? defaultShell()]
}

type XtermCellLike = {
  getChars(): string
  getWidth(): number
  isFgDefault(): boolean
  isBgDefault(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  isFgRGB(): boolean
  isBgRGB(): boolean
  getFgColorMode(): number
  getBgColorMode(): number
  getFgColor(): number
  getBgColor(): number
  isAttributeDefault(): boolean
  isBold(): boolean | number
  isDim(): boolean | number
  isItalic(): boolean | number
  isUnderline(): boolean | number
  isBlink(): boolean | number
  isInverse(): boolean | number
  isInvisible(): boolean | number
  isStrikethrough(): boolean | number
}

type RenderStyle = {
  fg: string
  bg: string
  attrs: number
}

const DEFAULT_RENDER_STYLE: RenderStyle = Object.freeze({ fg: "", bg: "", attrs: 0 })

function sgrEscape(params: readonly (number | string)[]): string {
  return `\x1b[${params.join(";")}m`
}

function paletteColorToSgr(index: number, base: 30 | 40): number[] {
  if (index >= 0 && index <= 7) return [base + index]
  if (index >= 8 && index <= 15) return [base + 60 + (index - 8)]
  return [base === 30 ? 38 : 48, 5, index]
}

function rgbColorToSgr(rgb: number, base: 38 | 48): number[] {
  const r = (rgb >> 16) & 0xff
  const g = (rgb >> 8) & 0xff
  const b = rgb & 0xff
  return [base, 2, r, g, b]
}

function colorKey(cell: XtermCellLike, kind: "fg" | "bg"): string {
  const isDefault = kind === "fg" ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) return ""
  const mode = kind === "fg" ? cell.getFgColorMode() : cell.getBgColorMode()
  const color = kind === "fg" ? cell.getFgColor() : cell.getBgColor()
  if (mode === XTERM_COLOR_MODE_RGB || (kind === "fg" ? cell.isFgRGB() : cell.isBgRGB())) return `rgb:${color}`
  if (mode === XTERM_COLOR_MODE_PALETTE || (kind === "fg" ? cell.isFgPalette() : cell.isBgPalette())) {
    return `pal:${color}`
  }
  if (mode === XTERM_COLOR_MODE_DEFAULT) return ""
  return ""
}

function cellStyle(cell: XtermCellLike): RenderStyle {
  let attrs = 0
  if (cell.isBold()) attrs |= 1 << 0
  if (cell.isDim()) attrs |= 1 << 1
  if (cell.isItalic()) attrs |= 1 << 2
  if (cell.isUnderline()) attrs |= 1 << 3
  if (cell.isBlink()) attrs |= 1 << 4
  if (cell.isInverse()) attrs |= 1 << 5
  if (cell.isInvisible()) attrs |= 1 << 6
  if (cell.isStrikethrough()) attrs |= 1 << 7
  return {
    fg: colorKey(cell, "fg"),
    bg: colorKey(cell, "bg"),
    attrs,
  }
}

function styleEquals(a: RenderStyle, b: RenderStyle): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs
}

function styleToSgr(style: RenderStyle): string {
  if (styleEquals(style, DEFAULT_RENDER_STYLE)) return sgrEscape([0])
  const params: (number | string)[] = [0]
  if (style.attrs & (1 << 0)) params.push(1)
  if (style.attrs & (1 << 1)) params.push(2)
  if (style.attrs & (1 << 2)) params.push(3)
  if (style.attrs & (1 << 3)) params.push(4)
  if (style.attrs & (1 << 4)) params.push(5)
  if (style.attrs & (1 << 5)) params.push(7)
  if (style.attrs & (1 << 6)) params.push(8)
  if (style.attrs & (1 << 7)) params.push(9)
  for (const [kind, key] of [
    ["fg", style.fg],
    ["bg", style.bg],
  ] as const) {
    if (key === "") continue
    const [, raw] = key.split(":")
    const value = Number(raw)
    if (key.startsWith("rgb:")) params.push(...rgbColorToSgr(value, kind === "fg" ? 38 : 48))
    if (key.startsWith("pal:")) params.push(...paletteColorToSgr(value, kind === "fg" ? 30 : 40))
  }
  return sgrEscape(params)
}

function isVisibleCell(cell: XtermCellLike): boolean {
  const chars = cell.getChars()
  if (chars !== "" && chars !== " ") return true
  return !cell.isAttributeDefault() || !cell.isFgDefault() || !cell.isBgDefault()
}

function xtermLineToAnsi(
  line: { length: number; getCell(index: number): XtermCellLike | undefined },
  minLast = -1,
): string {
  let last = Math.min(line.length - 1, minLast)
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    if (isVisibleCell(cell)) last = x
  }
  if (last === -1) return ""

  let out = ""
  let active = DEFAULT_RENDER_STYLE
  for (let x = 0; x <= last; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const next = cellStyle(cell)
    if (!styleEquals(active, next)) {
      out += styleToSgr(next)
      active = next
    }
    out += cell.getChars() || " "
  }
  if (!styleEquals(active, DEFAULT_RENDER_STYLE)) out += styleToSgr(DEFAULT_RENDER_STYLE)
  return out
}

/* --------------------------------------------------------------------- */
/*  Bun PTY backend                                                       */
/* --------------------------------------------------------------------- */

export class BunTerminalTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly proc: ReturnType<typeof Bun.spawn>
  private readonly term: XtermHeadless
  private readonly listeners = new Set<DataListener>()
  private buffer = ""
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
    if (this.buffer !== "") {
      try {
        cb(this.buffer, this.cursor)
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

  capture(): string {
    return this.buffer
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
    const chunk = typeof data === "string" ? data : Buffer.from(data).toString("utf8")
    this.term.write(chunk, () => this.queueRefresh())
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
    const rows: string[] = []
    const cursorY = active.baseY + active.cursorY
    const start = Math.max(0, active.length - (this.rows + VISIBLE_SCROLLBACK_MARGIN_ROWS))
    for (let y = start; y < active.length; y++) {
      const line = active.getLine(y)
      const minLast = y === cursorY ? active.cursorX - 1 : -1
      rows.push(line ? xtermLineToAnsi(line, minLast) : "")
    }
    this.buffer = rows.join("\n")
    // A hidden cursor (`?25l`) reports as null so the pane draws no
    // inverse cursor cell — same contract as a backend that can't
    // report a cursor at all.
    this.cursor = this.cursorHidden() ? null : { x: active.cursorX, y: active.baseY + active.cursorY - start }
    for (const cb of this.listeners) {
      try {
        cb(this.buffer, this.cursor)
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

    // Do not pass `-i`: interactive shells expect a controlling TTY for
    // job control and can suspend the host TUI when backed only by pipes.
    // A `command` override (e.g. `["claude"]`) carries its own argv.
    const argv = resolveArgv(opts)
    const exe = argv[0] ?? defaultShell()
    const args = argv.slice(1)
    this.proc = spawn(exe, args, {
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
  const backend = process.env.KOBE_TERMINAL_BACKEND ?? "bun-pty"
  if (backend === "mock") return new MockTaskPty(opts)
  if (backend === "pipe") return new PipeTaskPty(opts)
  if (backend === "bun-pty") return new BunTerminalTaskPty(opts)
  throw new Error(`unknown terminal backend: ${backend}`)
}

export type TaskPty = TaskPtyLike
