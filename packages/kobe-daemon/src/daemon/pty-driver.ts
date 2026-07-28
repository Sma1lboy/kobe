/**
 * How a PTY child gets spawned — the one runtime-specific seam in the PTY
 * host.
 *
 * `PtyHost` owns sessions, scrollback, replay, and lifetime; none of that
 * cares which API produced the pseudo-terminal. Two drivers exist because no
 * single API covers every platform kobe runs on:
 *
 *   - `bunTerminalDriver` — `Bun.spawn(..., { terminal })`. The default, and
 *     the only one used on macOS and Linux.
 *   - `nodePtyDriver` — `node-pty` (ConPTY). Windows only, and it must run
 *     under NODE: Bun can import node-pty and read from it, but writing to
 *     the ConPTY input pipe fails with `ERR_SOCKET_CLOSED`, so a Bun-hosted
 *     node-pty session is one you cannot type into. Bun's own `terminal`
 *     option is rejected outright on Windows ("terminal option is not
 *     supported on this platform"), which is why the Windows PTY host is a
 *     separate node process rather than the usual Bun one.
 *
 * Keeping the seam this narrow is deliberate: everything above it — the ring
 * buffer, OSC title scanning, park/replay, sweep — stays single-implementation
 * and identically tested on every platform.
 */

/** The slice of a spawned PTY child that `PtyHost` actually drives. */
export interface PtyChild {
  readonly pid: number
  /** Settles when the child exits. Never rejects meaningfully — exit is exit. */
  readonly exited: Promise<unknown>
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Release the pty handle once exited. Must tolerate being called twice. */
  close(): void
  kill(signal: NodeJS.Signals): void
}

export interface PtySpawnRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string | undefined>
  readonly cols: number
  readonly rows: number
  /** Raw child output. `PtyHost` normalises to Buffer. */
  onData(data: string | Uint8Array): void
}

export type PtyDriver = (request: PtySpawnRequest) => PtyChild

const TERMINAL_NAME = "xterm-256color"

/** The terminal handle Bun hangs off a spawned proc. Absent once it exits. */
export interface BunTerminalHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

/** The slice of `Bun.spawn`'s result this driver drives. */
export interface BunTerminalProc {
  readonly pid: number
  readonly exited: Promise<unknown>
  readonly terminal?: BunTerminalHandle
  kill(signal: NodeJS.Signals): void
}

export interface BunTerminalOptions {
  cwd: string
  env: Record<string, string | undefined>
  terminal: { cols: number; rows: number; name: string; data: (terminal: unknown, data: Uint8Array) => void }
}

export type BunTerminalSpawn = (argv: string[], options: BunTerminalOptions) => BunTerminalProc

/**
 * `Bun.spawn(..., { terminal })` — the default on macOS and Linux.
 *
 * `spawn` is injectable for the same reason node-pty's is: `Bun` is not a
 * global under the test runner, so the translation below could not otherwise
 * be asserted anywhere — and this is the driver almost every kobe user runs.
 */
export function bunTerminalDriver(spawn?: BunTerminalSpawn): PtyDriver {
  const spawnTerminal =
    spawn ??
    // biome-ignore lint/suspicious/noExplicitAny: `terminal` is absent from Bun's public SpawnOptions type.
    ((argv, options) => (Bun.spawn as any)(argv, options) as BunTerminalProc)
  return (request) => {
    const proc = spawnTerminal([...request.argv], {
      cwd: request.cwd,
      env: request.env,
      terminal: {
        cols: request.cols,
        rows: request.rows,
        name: TERMINAL_NAME,
        data: (_terminal: unknown, data: Uint8Array) => request.onData(data),
      },
    })
    return {
      pid: proc.pid,
      exited: proc.exited,
      // The handle disappears when the child exits, so every use is optional —
      // a late write from a detaching client must not throw past the host.
      write: (data) => proc.terminal?.write(data),
      resize: (cols, rows) => proc.terminal?.resize(cols, rows),
      close: () => proc.terminal?.close(),
      kill: (signal) => proc.kill(signal),
    }
  }
}

/** The slice of node-pty's child this driver drives. */
export interface NodePtyChild {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** node-pty's `spawn`, narrowed to what this driver passes it. */
export type NodePtySpawn = (
  file: string,
  args: readonly string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => NodePtyChild

/**
 * `node-pty` (ConPTY on Windows). Async because node-pty is a native module
 * loaded only by the host that actually needs it — importing it eagerly would
 * drag a napi binding into every Bun-hosted daemon on every platform.
 *
 * `spawn` is injectable so the translation below — event wiring, the exit
 * promise, env narrowing — is unit-testable on a runner where the native
 * binding was never built.
 */
export async function nodePtyDriver(spawn?: NodePtySpawn): Promise<PtyDriver> {
  const spawnPty = spawn ?? ((await import("node-pty")).spawn as unknown as NodePtySpawn)
  return (request) => {
    const [file, ...args] = request.argv
    const child = spawnPty(file ?? "", args, {
      name: TERMINAL_NAME,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: Object.fromEntries(
        Object.entries(request.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    })
    let settle: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      settle = resolve
    })
    child.onData((data) => request.onData(data))
    child.onExit(({ exitCode }) => settle(exitCode))
    return {
      pid: child.pid,
      exited,
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      // node-pty ties the handle's life to the child; there is nothing extra
      // to release, and `kill()` after exit throws.
      close: () => {},
      // ConPTY has no signals — node-pty maps every kill to TerminateProcess,
      // so SIGTERM and SIGKILL collapse into the same call here.
      kill: () => child.kill(),
    }
  }
}
