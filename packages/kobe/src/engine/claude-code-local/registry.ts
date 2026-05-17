/**
 * In-memory bookkeeping for live engine subprocesses.
 *
 * Despite living under `claude-code-local/`, this registry is
 * **engine-agnostic** and shared: `CodexLocal` imports it too, so
 * `stop()` reaps a `codex` process exactly the way it reaps a `claude`
 * one. Anything engine-specific (event shapes, session-id discovery)
 * stays in the per-engine adapter; the registry only owns "find the
 * child by `sessionId`, signal its process tree, free the slot."
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
 * not known until the engine's init event arrives — registration
 * therefore happens *after* spawn, inside the engine adapter.
 */

import type { ChildProcess } from "node:child_process"

/** Internal record held against each running session. */
export interface ProcessHandle {
  readonly sessionId: string
  readonly cwd: string
  readonly proc: ChildProcess
  readonly startedAt: number
  /**
   * The prompt this subprocess is processing. Kept on the handle so a
   * mid-stream SIGTERM (steer / ESC interrupt) can rescue the user
   * turn into the session JSONL — `claude -p` only commits the turn
   * to disk when it completes naturally, so a kill drops the message
   * on the floor unless we step in.
   */
  readonly prompt: string
}

/**
 * Map<sessionId, ProcessHandle> with a few convenience methods. Single
 * instance per `ClaudeCodeLocal`; not safe across processes.
 */
export class SessionRegistry {
  private readonly handles = new Map<string, ProcessHandle>()

  /**
   * Register a fresh session.
   *
   * If a prior entry exists, distinguish two cases:
   *
   *   - **Live duplicate** — the prior proc is still running. This is
   *     a real conflict (caller is racing two starts on the same
   *     sessionId). Throw — the second call must back off.
   *
   *   - **Stale duplicate** — the prior proc has already exited, but
   *     its cleanup didn't unregister (timing race between the parse
   *     IIFE's finally and our engine.stop, or a partial failure that
   *     left the entry orphaned). Treat as "registry empty": drop
   *     the stale handle, register the fresh one. The live process
   *     wins; the dead one was going to be unregistered anyway.
   *
   * Without the stale-entry recovery, a single missed cleanup (often
   * from a transient throw deep in the parse pipeline) makes every
   * subsequent `claude --resume <sid>` fail forever, because the
   * sessionId is reused across resumes — the registry slot is
   * load-bearing for the entire lifetime of the session, not just one
   * subprocess.
   */
  register(handle: ProcessHandle): void {
    const existing = this.handles.get(handle.sessionId)
    if (existing) {
      const stale = existing.proc.exitCode !== null || existing.proc.signalCode !== null
      if (!stale) {
        throw new Error(`SessionRegistry: duplicate sessionId ${handle.sessionId}`)
      }
      // Fall through and overwrite the stale entry.
    }
    this.handles.set(handle.sessionId, handle)
  }

  /**
   * Remove a session record. Idempotent.
   *
   * When `proc` is provided, only remove the record if it still points
   * at that exact child. This lets an old turn finish cleanup after a
   * fast resume without unregistering the new subprocess that reused
   * the same session id.
   */
  unregister(sessionId: string, proc?: ChildProcess): void {
    if (proc) {
      const existing = this.handles.get(sessionId)
      if (existing && existing.proc !== proc) return
    }
    this.handles.delete(sessionId)
  }

  /** Look up a session by id. Returns `undefined` if not running. */
  get(sessionId: string): ProcessHandle | undefined {
    return this.handles.get(sessionId)
  }

  /**
   * Send SIGTERM (graceful) and, after `graceMs` ms without exit, SIGKILL.
   *
   * The signal targets the child's whole process *group*, not just the
   * engine PID — both `claude` and `codex` spawn tool / subagent /
   * sandbox children, and a bare `proc.kill()` leaves those descendants
   * alive (the user presses Esc, the subagent keeps working). Every
   * engine spawns its subprocess `detached` so it leads its own group;
   * `process.kill(-pid, …)` then reaches every descendant. We still
   * signal `proc` directly as a fallback.
   *
   * The registry slot is freed **synchronously, up front** — before any
   * signal is sent. A kill is irreversible, so the moment we commit to
   * it the id must be available for a follow-up `resume(sessionId,…)`.
   * Claude emits its terminal `result` record (which the pump turns
   * into a `done`, flipping the UI back to idle) *before* the process
   * actually exits; deferring the unregister until exit left a window
   * where a prompt sent from the now-idle UI hit `register()` against a
   * slot still holding the dying subprocess and threw
   * `duplicate sessionId`.
   *
   * Returns once the child has exited — or once we've issued SIGKILL
   * and 1s further has elapsed (defensive for hung processes that never
   * surface a close event).
   *
   * Idempotent: stopping an already-gone session is a no-op.
   */
  async kill(sessionId: string, graceMs = 5_000): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle) return

    // Free the slot first — see the doc comment above.
    this.handles.delete(sessionId)

    const proc = handle.proc
    if (proc.exitCode !== null || proc.signalCode !== null) return

    const exited = waitForExit(proc)

    signalTree(proc, "SIGTERM")

    const winner = await Promise.race([
      exited.then(() => "exit" as const),
      delay(graceMs).then(() => "timeout" as const),
    ])

    if (winner === "timeout") {
      signalTree(proc, "SIGKILL")
      // Bound the SIGKILL wait too — defensive.
      await Promise.race([exited, delay(1_000)])
    }
  }
}

/**
 * Signal a child and every descendant in its process group.
 *
 * Engine subprocesses are spawned `detached`, so the child PID is also
 * its process-group id; `process.kill(-pid, …)` delivers to the whole
 * group. We attempt the group signal first and fall back to a direct
 * `proc.kill()` if the group send fails (e.g. the leader already
 * exited, the child was not spawned detached, or `pid` is gone).
 */
function signalTree(proc: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = proc.pid
  if (typeof pid === "number") {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Group gone / not a group leader — fall through to a direct kill.
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // Process already gone between the liveness check and here.
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
