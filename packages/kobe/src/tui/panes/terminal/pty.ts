/**
 * Terminal pane process abstraction.
 *
 * kobe deliberately does NOT use tmux here anymore. The default backend
 * (`HostedTaskPty`, `pty-hosted.ts`) keeps the raw PTY in the standalone
 * `kobe pty-host` process so an engine session survives TUI exits AND
 * daemon restarts, reattaching with scrollback; `BunTerminalTaskPty`
 * below is the local fallback using Bun's native PTY support
 * (`Bun.spawn(..., { terminal })`) directly in the TUI process.
 *
 * Both feed a headless xterm emulator that turns terminal control bytes
 * into a stable screen buffer for opentui to render — that shared half
 * lives in `pty-xterm-base.ts`. xterm's authoritative cell grid renders
 * DIRECTLY into opentui-ready style runs (`Chunk[]` per row); we do not
 * re-serialize cells back to ANSI and re-parse them. (The old
 * cell→ANSI→reparse round-trip was where every render bug lived.)
 *
 * A pipe backend remains available through `KOBE_TERMINAL_BACKEND=pipe`
 * as a fallback for old Bun builds or unsupported platforms. It has no
 * emulator, so it still parses its raw byte buffer via `sgr.ts` into the
 * same `Chunk[]` rows.
 */

import { embeddedTerminalEnv } from "@sma1lboy/kobe-daemon/daemon/pty-env"
import { HostedTaskPty } from "./pty-hosted"
import { MockTaskPty } from "./pty-mock"
import { PipeTaskPty } from "./pty-pipe"
import { type TaskPtyLike, type TaskPtyOpts, resolveArgv } from "./pty-types"
import { XtermTaskPty } from "./pty-xterm-base"

export { MockTaskPty } from "./pty-mock"
export { PipeTaskPty } from "./pty-pipe"
export { HostedTaskPty } from "./pty-hosted"
export type { CursorPos, DataListener, ParkedScreen, TaskPtyLike, TaskPtyOpts, TerminalRow } from "./pty-types"

/* --------------------------------------------------------------------- */
/*  Bun PTY backend (local child — dies with the TUI process)             */
/* --------------------------------------------------------------------- */

export class BunTerminalTaskPty extends XtermTaskPty {
  private readonly proc: ReturnType<typeof Bun.spawn>

  constructor(opts: TaskPtyOpts) {
    super(opts)
    this.proc = Bun.spawn(resolveArgv(opts), {
      cwd: opts.cwd,
      env: embeddedTerminalEnv(process.env, {
        TERM: "xterm-256color",
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
        BASH_SILENCE_DEPRECATION_WARNING: "1",
        KOBE_TERMINAL_PTY: "1",
      }),
      terminal: {
        cols: this.cols,
        rows: this.rows,
        name: "xterm-256color",
        data: (_terminal, data) => this.feed(data),
        exit: () => this.markDead(false),
      },
    })
    void this.proc.exited.then(
      () => this.markDead(false),
      () => this.markDead(false),
    )
    this.proc.unref?.()
    if (opts.initialInput) this.transportWrite(opts.initialInput)
  }

  protected transportWrite(data: string): void {
    this.proc.terminal?.write(data)
  }

  protected transportResize(cols: number, rows: number): void {
    this.proc.terminal?.resize(cols, rows)
  }

  protected transportKill(): void {
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
}

/* --------------------------------------------------------------------- */
/*  Backend selection                                                     */
/* --------------------------------------------------------------------- */

export function createTaskPty(opts: TaskPtyOpts): TaskPtyLike {
  const backend = process.env.KOBE_TERMINAL_BACKEND ?? "hosted"
  if (backend === "mock") return new MockTaskPty(opts)
  if (backend === "pipe") return new PipeTaskPty(opts)
  if (backend === "bun-pty") return new BunTerminalTaskPty(opts)
  if (backend === "hosted") return new HostedTaskPty(opts)
  throw new Error(`unknown terminal backend: ${backend}`)
}

export type TaskPty = TaskPtyLike
