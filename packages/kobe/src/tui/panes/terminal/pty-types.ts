import { parse } from "@ansi-tools/parser"
import type { Chunk } from "./sgr"

/** One rendered row: a list of opentui-ready style runs. */
export type TerminalRow = readonly Chunk[]

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

/**
 * Listener for new pane snapshots. Receives the full screen as
 * structured rows (one `Chunk[]` per row) plus the cursor position.
 */
export type DataListener = (rows: readonly TerminalRow[], cursor: CursorPos | null) => void

/** Cursor position within the rendered pane, 0-based. */
export type CursorPos = { x: number; y: number }

export interface TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  readonly killed: boolean

  write(data: string): void
  /**
   * Deliver pasted text. Backends that can see the app's DECSET 2004
   * state wrap it in bracketed-paste markers when (and only when) the
   * app asked for them — pasting a multiline prompt into an engine CLI
   * must not execute line-by-line.
   */
  paste(text: string): void
  onData(cb: DataListener): () => void
  /**
   * Notify once when the underlying process ends for ANY reason (its own
   * exit, a write failure, or kill()). Fires immediately if already dead —
   * a pane subscribing after a fast crash must still see the state. The
   * pane renders a dead-shell banner off this instead of silently freezing
   * on the last snapshot (revival checklist #5).
   */
  onExit(cb: () => void): () => void
  /**
   * Notify when the foreground command's window title changes — the
   * same OSC 0/2 mechanism a real terminal emulator uses to show "vim"
   * or "htop" in a tab instead of a static "shell" (real terminals track
   * this per-pane). Fires immediately with the latest known title on
   * subscribe, same replay contract as `onData`. Never fires if the
   * shell/program never sets one.
   */
  onTitleChange(cb: (title: string) => void): () => void
  /**
   * Route a mouse-wheel tick the way a real terminal emulator would:
   * the app enabled mouse tracking → encode an SGR wheel event at
   * (col,row) (1-based, pane-local) and forward it — the app scrolls
   * itself (claude's transcript, less, vim…); app on the alternate
   * screen without mouse tracking → 3× arrow-key fallback. Returns
   * false when the app asked for neither — the CALLER then scrolls its
   * local scrollback view, exactly like a normal terminal's wheel.
   */
  wheel(direction: "up" | "down", col: number, row: number): boolean
  resize(cols: number, rows: number): void
  capture(): readonly TerminalRow[]
  captureCursor(): CursorPos | null
  kill(): void
}

export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24
export const PIPE_SCROLLBACK_LIMIT = 200_000
export const VISIBLE_SCROLLBACK_MARGIN_ROWS = 200

export function defaultShell(): string {
  return process.env.SHELL ?? "/bin/bash"
}

/**
 * Extract the last OSC 0/2 (icon+title / title) escape's payload from a
 * chunk of raw terminal output — `\x1b]0;name\x07` or `\x1b]2;name\x07`,
 * the window-title mechanism shells/programs (vim, htop, ssh, npm…) use
 * to name themselves. Backends without a full emulator (`PipeTaskPty`,
 * `MockTaskPty`) call this per chunk; `BunTerminalTaskPty` gets it for
 * free from `@xterm/headless`'s own `onTitleChange`. Returns null if the
 * chunk carries no title escape.
 */
export function extractOscTitle(chunk: string): string | null {
  let title: string | null = null
  for (const code of parse(chunk)) {
    if (code.type === "OSC" && (code.command === "0" || code.command === "2") && code.params[0]) {
      title = code.params[0]
    }
  }
  return title
}

/**
 * Resolve the argv a `TaskPty` should spawn. Honours an explicit
 * `command` override (the `["claude"]` interactive-engine path used by
 * the chat pane) and otherwise falls back to a single-element shell
 * argv — the terminal pane's default.
 */
export function resolveArgv(opts: TaskPtyOpts): string[] {
  if (opts.command && opts.command.length > 0) return [...opts.command]
  return [opts.shell ?? defaultShell()]
}
