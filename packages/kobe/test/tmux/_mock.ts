/**
 * Tiny test double for a `tmux -CC` child process. Returns the same
 * shape as `node:child_process.ChildProcess` for the surfaces
 * `TmuxControlClient` cares about: `stdin` (Writable), `stdout`,
 * `stderr` (Readable), `on/once/off` for `exit` / `close` / `error`,
 * and a `kill()` that simulates the child exiting on signal. Tests
 * drive tmux behaviour through `simulateOutput()` / `simulateStderr()`
 * / `simulateExit()` rather than touching the streams directly.
 */

import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable, type Writable } from "node:stream"

export interface MockTmuxChild {
  readonly child: ChildProcess
  readonly stdinChunks: Buffer[]
  simulateOutput(data: string | Buffer): void
  simulateStderr(data: string | Buffer): void
  simulateExit(code: number | null, signal?: NodeJS.Signals): void
  killed: boolean
}

class MockChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  pid = 4242
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private writeBuf: Buffer[]
  private exited = false

  constructor(writeBuf: Buffer[]) {
    super()
    this.writeBuf = writeBuf
    const stdinSink = new PassThrough()
    stdinSink.on("data", (chunk: Buffer) => {
      this.writeBuf.push(chunk)
    })
    this.stdin = stdinSink
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exited) return false
    this.killed = true
    const sig: NodeJS.Signals = typeof signal === "string" ? signal : "SIGTERM"
    queueMicrotask(() => this.simulateExit(null, sig))
    return true
  }

  simulateOutput(data: string | Buffer): void {
    const buf = typeof data === "string" ? Buffer.from(data, "binary") : data
    ;(this.stdout as PassThrough).write(buf)
  }

  simulateStderr(data: string | Buffer): void {
    const buf = typeof data === "string" ? Buffer.from(data) : data
    ;(this.stderr as PassThrough).write(buf)
  }

  simulateExit(code: number | null, signal?: NodeJS.Signals): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    this.signalCode = signal ?? null
    this.emit("exit", code, signal ?? null)
    this.emit("close", code, signal ?? null)
  }
}

export function makeMockTmuxChild(): MockTmuxChild {
  const writeBuf: Buffer[] = []
  const child = new MockChild(writeBuf)
  return {
    child: child as unknown as ChildProcess,
    stdinChunks: writeBuf,
    simulateOutput: (data) => child.simulateOutput(data),
    simulateStderr: (data) => child.simulateStderr(data),
    simulateExit: (code, signal) => child.simulateExit(code, signal),
    get killed(): boolean {
      return child.killed
    },
    set killed(_v: boolean) {
      /* read-only */
    },
  }
}

export function writesAsText(chunks: readonly Buffer[]): string {
  return chunks.map((b) => b.toString("utf8")).join("")
}
