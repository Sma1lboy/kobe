import type { Chunk } from "./sgr"

export type TerminalRow = readonly Chunk[]

export type TaskPtyOpts = {
  cwd: string
  taskId: string
  cols?: number
  rows?: number
  shell?: string
  command?: readonly string[]
}

export type DataListener = (rows: readonly TerminalRow[], cursor: CursorPos | null) => void

export type CursorPos = { x: number; y: number }

export interface TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  readonly killed: boolean

  write(data: string): void
  paste(text: string): void
  onData(cb: DataListener): () => void
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

export function resolveArgv(opts: TaskPtyOpts): string[] {
  if (opts.command && opts.command.length > 0) return [...opts.command]
  return [opts.shell ?? defaultShell()]
}
