/**
 * A tiny pane kit for `[[panes]]` entrypoints: alternate screen, raw-mode
 * keys, resize, and absolute-addressed full-frame draws — the boilerplate
 * every terminal "page" needs, and nothing more. For rich UIs bring your
 * own framework; this is for the 100-line status board.
 *
 * Draws use per-row cursor addressing (CUP) + erase-to-EOL, never newline
 * flow — relative-flow writes are what produced ghost wrap lines in
 * embedded terminals. Lines longer than the terminal width will wrap;
 * keep rows within `pane.cols` (mind CJK double-width).
 */

export interface Key {
  /** "a", "B", "1"… for printables; names for specials: "enter", "escape",
   *  "tab", "backspace", "space", "up", "down", "left", "right". */
  readonly name: string
  readonly ctrl: boolean
}

export interface PaneOptions {
  /** Exit the process on ctrl+c (default true). */
  readonly exitOnCtrlC?: boolean
  readonly input?: NodeJS.ReadStream
  readonly output?: NodeJS.WriteStream
}

const SPECIALS: Record<string, string> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  " ": "space",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
}

/** Parse one raw stdin chunk into key events (exported for tests). */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = []
  for (let i = 0; i < chunk.length; i++) {
    const three = chunk.slice(i, i + 3)
    if (SPECIALS[three]) {
      keys.push({ name: SPECIALS[three] as string, ctrl: false })
      i += 2
      continue
    }
    const ch = chunk[i] as string
    if (SPECIALS[ch]) {
      keys.push({ name: SPECIALS[ch] as string, ctrl: false })
    } else if (ch === "\x1b") {
      keys.push({ name: "escape", ctrl: false }) // lone ESC or unknown CSI head
    } else if (ch >= "\x01" && ch <= "\x1a") {
      keys.push({ name: String.fromCharCode(ch.charCodeAt(0) + 96), ctrl: true })
    } else if (ch >= " ") {
      keys.push({ name: ch, ctrl: false })
    }
  }
  return keys
}

export class Pane {
  readonly input: NodeJS.ReadStream
  readonly output: NodeJS.WriteStream
  private keyHandler: ((key: Key) => void) | null = null
  private resizeHandler: (() => void) | null = null
  private started = false
  private readonly exitOnCtrlC: boolean
  private readonly cleanupFns: Array<() => void> = []

  constructor(opts: PaneOptions = {}) {
    this.input = opts.input ?? process.stdin
    this.output = opts.output ?? process.stdout
    this.exitOnCtrlC = opts.exitOnCtrlC ?? true
  }

  get cols(): number {
    return this.output.columns ?? 80
  }
  get rows(): number {
    return this.output.rows ?? 24
  }

  /** Enter alt screen + raw mode; wires key/resize/exit restoration. */
  start(): void {
    if (this.started) return
    this.started = true
    this.output.write("\x1b[?1049h\x1b[?25l\x1b[2J")
    if (this.input.isTTY) this.input.setRawMode(true)
    this.input.setEncoding("utf8")
    const onData = (chunk: string) => {
      for (const key of parseKeys(chunk)) {
        if (key.ctrl && key.name === "c" && this.exitOnCtrlC) this.exit(0)
        this.keyHandler?.(key)
      }
    }
    const onResize = () => this.resizeHandler?.()
    const onSignal = () => this.exit(0)
    this.input.on("data", onData)
    this.output.on("resize", onResize)
    process.on("SIGTERM", onSignal)
    process.on("SIGHUP", onSignal)
    this.cleanupFns.push(() => {
      this.input.off("data", onData)
      this.output.off("resize", onResize)
      process.off("SIGTERM", onSignal)
      process.off("SIGHUP", onSignal)
    })
    this.input.resume()
  }

  onKey(handler: (key: Key) => void): void {
    this.keyHandler = handler
  }
  onResize(handler: () => void): void {
    this.resizeHandler = handler
  }

  /** Paint a full frame: row i → screen row i+1, each erased to EOL. */
  draw(lines: readonly string[]): void {
    const rows = this.rows
    let out = ""
    for (let i = 0; i < rows; i++) {
      out += `\x1b[${i + 1};1H\x1b[K${lines[i] ?? ""}`
    }
    this.output.write(out)
  }

  /** Restore the terminal (leave alt screen, show cursor, cooked mode). */
  stop(): void {
    if (!this.started) return
    this.started = false
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns.length = 0
    if (this.input.isTTY) this.input.setRawMode(false)
    this.input.pause()
    this.output.write("\x1b[?25h\x1b[?1049l")
  }

  /** stop() then process.exit(code). */
  exit(code = 0): never {
    this.stop()
    process.exit(code)
  }
}
