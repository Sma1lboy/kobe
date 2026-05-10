/**
 * In-memory bookkeeping for live Claude Code subprocesses.
 *
 * Modeled after `refs/opcode/src-tauri/src/process/registry.rs` but
 * stripped down: opcode tracks `run_id`s tied to a SQLite agent table
 * and persists live output for late-subscriber UIs. We don't need any
 * of that — kobe pumps the stream directly into per-task event buses
 * (see Stream E in PLAN.md), and the orchestrator's task index is
 * already on disk. This registry exists for one reason: **stop()**
 * needs to find the child process by `sessionId` to send signals.
 *
 * We register on session id (not on a synthetic key) because the
 * canonical {@link SessionHandle} only exposes `sessionId`, and we
 * want `stop(handle)` to be a single map lookup. The session id is
 * not known until the `system.init` event arrives — registration
 * therefore happens *after* spawn, inside ClaudeCodeLocal.
 */

import type { ChildProcess } from "node:child_process"

/** Internal record held against each running session. */
export interface ProcessHandle {
  readonly sessionId: string
  readonly cwd: string
  readonly proc: ChildProcess
  readonly startedAt: number
}

/**
 * Map<sessionId, ProcessHandle> with a few convenience methods. Single
 * instance per `ClaudeCodeLocal`; not safe across processes.
 */
export class SessionRegistry {
  private readonly handles = new Map<string, ProcessHandle>()

  /** Register a fresh session. Throws if `sessionId` is already taken. */
  register(handle: ProcessHandle): void {
    if (this.handles.has(handle.sessionId)) {
      throw new Error(`SessionRegistry: duplicate sessionId ${handle.sessionId}`)
    }
    this.handles.set(handle.sessionId, handle)
  }

  /** Remove a session record. Idempotent. */
  unregister(sessionId: string): void {
    this.handles.delete(sessionId)
  }

  /** Look up a session by id. Returns `undefined` if not running. */
  get(sessionId: string): ProcessHandle | undefined {
    return this.handles.get(sessionId)
  }

  /**
   * Send SIGTERM (graceful) and, after `graceMs` ms without exit, SIGKILL.
   *
   * Returns once the child has exited — or once we've issued SIGKILL
   * and 1s further has elapsed (defensive for hung processes that never
   * surface a close event). Always unregisters on completion.
   *
   * Idempotent: stopping an already-gone session is a no-op.
   */
  async kill(sessionId: string, graceMs = 5_000): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle) return

    const proc = handle.proc
    if (proc.exitCode !== null || proc.signalCode !== null) {
      this.unregister(sessionId)
      return
    }

    const exited = waitForExit(proc)

    try {
      proc.kill("SIGTERM")
    } catch {
      // process already gone between the check above and the kill;
      // proceed to the wait, which will resolve immediately.
    }

    const winner = await Promise.race([
      exited.then(() => "exit" as const),
      delay(graceMs).then(() => "timeout" as const),
    ])

    if (winner === "timeout") {
      try {
        proc.kill("SIGKILL")
      } catch {
        // already gone
      }
      // Bound the SIGKILL wait too — defensive.
      await Promise.race([exited, delay(1_000)])
    }

    this.unregister(sessionId)
  }
}

function waitForExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve()
      return
    }
    proc.once("close", () => resolve())
    proc.once("exit", () => resolve())
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
