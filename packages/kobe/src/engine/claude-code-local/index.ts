/**
 * `ClaudeCodeLocal` — Phase-1 implementation of {@link AIEngine}.
 *
 * Wires together the four primitives in this directory:
 *
 *   binary.ts    : `findClaudeBinary()`           — where is `claude`?
 *   spawn.ts     : `spawnClaudeProcess()`         — fork the child
 *   stream.ts    : `parseStreamJson()`            — JSONL → EngineEvent
 *   history.ts   : `readHistory()`                — disk JSONL → Message[]
 *   registry.ts  : `SessionRegistry`              — sessionId → ChildProcess
 *
 * Lifecycle of one session:
 *
 *   spawn(cwd, prompt)
 *     → findClaudeBinary()
 *     → spawnClaudeProcess()                                     (PID exists)
 *     → tee stdout into:
 *         (a) a queue of EngineEvents for `stream(handle)`
 *         (b) onSessionId callback that resolves the spawn promise
 *     → resolve once `system.init` arrives                       (handle exists)
 *
 *   stream(handle)
 *     → drain the event queue lazily; terminate after `done` or `error`.
 *
 *   stop(handle)
 *     → SessionRegistry.kill(sessionId) — SIGTERM → 5s → SIGKILL.
 *
 *   resume(sessionId, prompt)
 *     → spawn() with `--resume <sessionId>` (Claude reuses the JSONL).
 *
 * Why we tee the stream rather than expose the parser directly:
 *   - `spawn()` has to RESOLVE on `system.init`, but the iterator
 *     consumer hasn't been called yet — we have to drive the parser
 *     ourselves. So we pump the parser eagerly into an internal queue
 *     and hand the queue out via `stream()`.
 *   - This also lets `stop()` cleanly terminate the iterator without
 *     leaking buffered events.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { AIEngine, EngineEvent, Message, SessionHandle, SpawnOpts } from "@/types/engine"
import { findClaudeBinary } from "./binary"
import { deleteHistory as deleteHistoryImpl, readHistory as readHistoryImpl } from "./history"
import { type ProcessHandle, SessionRegistry } from "./registry"
import { type SpawnedClaude, spawnClaudeProcess } from "./spawn"
import { parseStreamJson, readLines } from "./stream"

/** Constructor options. All optional — defaults are production-correct. */
export interface ClaudeCodeLocalOpts {
  /**
   * Override the binary discovery (used by behavior tests with a fake
   * binary). Returns the absolute path to `claude` (or a stand-in).
   */
  readonly binaryPathResolver?: () => Promise<string>
  /** Grace period for SIGTERM before escalating to SIGKILL. Default 5s. */
  readonly stopGraceMs?: number
}

/** Internal per-session bookkeeping in addition to the {@link SessionRegistry}. */
interface RunningSession {
  readonly sessionId: string
  readonly cwd: string
  readonly spawned: SpawnedClaude
  /** Buffered EngineEvents (parser is pumped eagerly; stream() drains lazily). */
  readonly queue: EngineEvent[]
  /** Resolvers waiting on a new event. */
  waiters: Array<() => void>
  /** True once the parser saw a terminal event or stdout closed. */
  closed: boolean
}

export class ClaudeCodeLocal implements AIEngine {
  private readonly registry = new SessionRegistry()
  private readonly running = new Map<string, RunningSession>()
  private readonly binaryPathResolver: () => Promise<string>
  private readonly stopGraceMs: number

  constructor(opts: ClaudeCodeLocalOpts = {}) {
    this.binaryPathResolver = opts.binaryPathResolver ?? findClaudeBinary
    this.stopGraceMs = opts.stopGraceMs ?? 5_000
  }

  async spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    return this.start({ cwd, prompt, opts })
  }

  async resume(sessionId: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    // For resume, Claude needs the original cwd. We don't track it
    // across kobe restarts here — the orchestrator owns Task.cwd. We
    // fall back to process.cwd() which is fine for in-process resume
    // tests; the orchestrator should always pass via `opts` if a
    // specific cwd is needed (we accept it through env: KOBE_RESUME_CWD).
    const cwd = opts?.env?.KOBE_RESUME_CWD ?? process.cwd()
    return this.start({ cwd, prompt, opts, resumeSessionId: sessionId })
  }

  stream(handle: SessionHandle): AsyncIterable<EngineEvent> {
    const sid = handle.sessionId
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        const session = self.running.get(sid)
        if (!session) return
        let idx = 0
        while (true) {
          if (idx < session.queue.length) {
            const ev = session.queue[idx++]
            if (!ev) continue
            yield ev
            if (ev.type === "done" || ev.type === "error") return
            continue
          }
          if (session.closed) return
          await new Promise<void>((resolve) => session.waiters.push(resolve))
        }
      },
    }
  }

  async readHistory(sessionId: string): Promise<Message[]> {
    return readHistoryImpl(sessionId)
  }

  async deleteHistory(sessionId: string): Promise<void> {
    return deleteHistoryImpl(sessionId)
  }

  async stop(handle: SessionHandle): Promise<void> {
    const sid = handle.sessionId
    await this.registry.kill(sid, this.stopGraceMs)
    const session = this.running.get(sid)
    if (session) {
      session.closed = true
      this.notify(session)
      this.running.delete(sid)
    }
  }

  // --- internals -----------------------------------------------------

  private async start(args: {
    cwd: string
    prompt: string
    opts?: SpawnOpts
    resumeSessionId?: string
  }): Promise<SessionHandle> {
    const binaryPath = await this.binaryPathResolver()
    const spawned = spawnClaudeProcess({
      binaryPath,
      cwd: args.cwd,
      prompt: args.prompt,
      model: args.opts?.model,
      permissionMode: args.opts?.permissionMode,
      env: args.opts?.env,
      resumeSessionId: args.resumeSessionId,
    })

    // The deferred we resolve once we observe a session id (or, for
    // resume, immediately because we already have one).
    let resolveHandle: (h: SessionHandle) => void = () => {}
    let rejectHandle: (e: unknown) => void = () => {}
    const handlePromise = new Promise<SessionHandle>((res, rej) => {
      resolveHandle = res
      rejectHandle = rej
    })

    // We can't put a session in the running map until we know its id.
    // Stash the partial state here; bind it once the id arrives.
    const queue: EngineEvent[] = []
    let session: RunningSession | undefined
    let bound = false

    const bind = (sessionId: string) => {
      if (bound) return
      bound = true
      session = {
        sessionId,
        cwd: args.cwd,
        spawned,
        queue,
        waiters: [],
        closed: false,
      }
      this.running.set(sessionId, session)
      this.registry.register({
        sessionId,
        cwd: args.cwd,
        proc: spawned.proc,
        startedAt: Date.now(),
      } satisfies ProcessHandle)
      resolveHandle({ sessionId, cwd: args.cwd })
    }

    // For resume, we already have the id — bind eagerly. The first
    // `system.init` from claude (if any) is a no-op (sessionIdEmitted
    // gating in the parser).
    if (args.resumeSessionId) {
      bind(args.resumeSessionId)
    }

    // Pump the parser into the queue. We start this inside an async
    // IIFE so spawn() can return as soon as bind() resolves.
    void (async () => {
      const events = parseStreamJson(readLines(spawned.stdout), {
        onSessionId: (sid) => bind(sid),
      })
      try {
        for await (const ev of events) {
          queue.push(ev)
          if (session) this.notify(session)
        }
      } catch (err) {
        const ev: EngineEvent = {
          type: "error",
          message: `parser failure: ${err instanceof Error ? err.message : String(err)}`,
        }
        queue.push(ev)
        if (session) this.notify(session)
      } finally {
        if (session) {
          session.closed = true
          this.notify(session)
          // Release the registry slot so the next `resume(sessionId,...)`
          // call (or a fresh spawn that happens to land on the same id
          // — `claude --resume <id>` reuses the id) can re-register
          // without colliding. Without this the process registry kept a
          // dead handle for every completed turn, and the second user
          // message in a session blew up with `duplicate sessionId`.
          this.registry.unregister(session.sessionId)
        }
        // If we never bound (no system.init ever arrived), reject the
        // spawn promise so callers don't hang forever.
        if (!bound) {
          rejectHandle(new Error("claude exited without emitting a session id"))
        }
      }
    })()

    // Drain stderr to avoid filling the OS pipe buffer (which would
    // block claude). We don't surface stderr lines as EngineEvents —
    // they're free-form CLI noise; the protocol-level errors come
    // through stream-json `result` records and are mapped above.
    drainStream(spawned.stderr)

    // If the process dies before emitting init (e.g. binary missing,
    // permission denied), surface that as a spawn failure.
    spawned.proc.once("error", (err) => {
      if (!bound) rejectHandle(err)
    })
    spawned.proc.once("exit", () => {
      if (!bound) {
        rejectHandle(new Error("claude exited before session id was captured"))
      }
    })

    return handlePromise
  }

  private notify(session: RunningSession): void {
    const waiters = session.waiters
    session.waiters = []
    for (const w of waiters) w()
  }
}

function drainStream(stream: NodeJS.ReadableStream | { on: ChildProcessWithoutNullStreams["stderr"]["on"] }): void {
  // `data` listener counts toward keeping the stream flowing; we
  // discard the chunks. `error` is also no-op so we don't crash on a
  // closed pipe.
  const s = stream as NodeJS.ReadableStream
  s.on("data", () => {})
  s.on("error", () => {})
}
