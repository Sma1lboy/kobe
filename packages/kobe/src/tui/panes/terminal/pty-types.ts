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
  onData(cb: DataListener): () => void
  /**
   * Notify once when the underlying process ends for ANY reason (its own
   * exit, a write failure, or kill()). Fires immediately if already dead —
   * a pane subscribing after a fast crash must still see the state. The
   * pane renders a dead-shell banner off this instead of silently freezing
   * on the last snapshot (revival checklist #5).
   */
  onExit(cb: () => void): () => void
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
 * Resolve the argv a `TaskPty` should spawn. Honours an explicit
 * `command` override (the `["claude"]` interactive-engine path used by
 * the chat pane) and otherwise falls back to a single-element shell
 * argv — the terminal pane's default.
 */
export function resolveArgv(opts: TaskPtyOpts): string[] {
  if (opts.command && opts.command.length > 0) return [...opts.command]
  return [opts.shell ?? defaultShell()]
}
