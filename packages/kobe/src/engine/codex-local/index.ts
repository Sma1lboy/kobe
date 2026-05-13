/**
 * `CodexLocal` — Phase-1 implementation of {@link AIEngine} backed by
 * `codex exec --json`.
 *
 * Structure mirrors `claude-code-local/`: one queue per session, one
 * tee from the parser into that queue, one shared {@link SessionRegistry}
 * for stop() lookups. The differences vs claude live in `spawn.ts`
 * (CLI flag set), `stream.ts` (codex JSONL → kobe EngineEvent), and the
 * on-disk history layout (`history.ts` / `sessions.ts`).
 *
 * See `claude-code-local/index.ts` for the full lifecycle comment block;
 * the behaviour is identical down to the bind-after-system-init trick.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type {
  AIEngine,
  EngineCapabilities,
  EngineEvent,
  EngineHistory,
  EngineIdentity,
  SessionHandle,
  SessionMeta,
  SpawnOpts,
} from "@/types/engine"
import { type ProcessHandle, SessionRegistry } from "../claude-code-local/registry"
import {
  type CodexBackend,
  type SpawnedCodexAppServer,
  resolveCodexBackend,
  spawnCodexAppServerTurn,
} from "./app-server"
import { findCodexBinary } from "./binary"
import { codexCapabilities, codexIdentity } from "./capabilities"
import { deleteHistory as deleteHistoryImpl, readHistoryWithMetrics as readHistoryImpl } from "./history"
import { resolveOpenRouterContextWindow } from "./openrouter"
import { listSessionsForCwd } from "./sessions"
import { type SpawnedCodex, spawnCodexProcess } from "./spawn"
import { parseStreamJson, readLines } from "./stream"

export interface CodexLocalOpts {
  readonly binaryPathResolver?: () => Promise<string>
  readonly stopGraceMs?: number
  readonly backend?: CodexBackend
}

interface RunningSession {
  readonly sessionId: string
  readonly cwd: string
  readonly spawned: SpawnedCodex | SpawnedCodexAppServer
  readonly queue: EngineEvent[]
  waiters: Array<() => void>
  closed: boolean
  readonly spawnedAtIso: string
}

export class CodexLocal implements AIEngine {
  readonly identity: EngineIdentity = codexIdentity
  readonly capabilities: EngineCapabilities = codexCapabilities
  private readonly registry = new SessionRegistry()
  private readonly running = new Map<string, RunningSession>()
  private readonly binaryPathResolver: () => Promise<string>
  private readonly stopGraceMs: number
  private readonly backend: CodexBackend

  constructor(opts: CodexLocalOpts = {}) {
    this.binaryPathResolver = opts.binaryPathResolver ?? findCodexBinary
    this.stopGraceMs = opts.stopGraceMs ?? 5_000
    this.backend = opts.backend ?? resolveCodexBackend()
  }

  async spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    return this.start({ cwd, prompt, opts })
  }

  async resume(sessionId: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    const cwd = opts?.cwd ?? opts?.env?.KOBE_RESUME_CWD ?? process.cwd()
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

  async readHistory(sessionId: string): Promise<EngineHistory> {
    return readHistoryImpl(sessionId)
  }

  async deleteHistory(sessionId: string): Promise<void> {
    return deleteHistoryImpl(sessionId)
  }

  async listSessions(cwd: string): Promise<SessionMeta[]> {
    return listSessionsForCwd(cwd)
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
    if (this.backend === "app-server") return this.startAppServer(args)
    return this.startExec(args)
  }

  private async startAppServer(args: {
    cwd: string
    prompt: string
    opts?: SpawnOpts
    resumeSessionId?: string
  }): Promise<SessionHandle> {
    const binaryPath = await this.binaryPathResolver()
    const queue: EngineEvent[] = []
    let session: RunningSession | undefined
    let bound = false
    let terminalSeen = false
    let stderrTail = ""
    let resolveHandle: (h: SessionHandle) => void = () => {}
    let rejectHandle: (e: unknown) => void = () => {}
    const handlePromise = new Promise<SessionHandle>((res, rej) => {
      resolveHandle = res
      rejectHandle = rej
    })

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
        spawnedAtIso: new Date().toISOString(),
      }
      this.running.set(sessionId, session)
      this.registry.register({
        sessionId,
        cwd: args.cwd,
        proc: spawned.proc,
        startedAt: Date.now(),
        prompt: args.prompt,
      } satisfies ProcessHandle)
      resolveHandle({ sessionId, cwd: args.cwd })
    }

    const emit = (ev: EngineEvent) => {
      if (ev.type === "done" || ev.type === "error") terminalSeen = true
      queue.push(ev)
      if (session) {
        this.notify(session)
        if (ev.type === "done" || ev.type === "error") {
          this.registry.unregister(session.sessionId, spawned.proc)
        }
      }
    }

    const spawned = spawnCodexAppServerTurn({
      binaryPath,
      cwd: args.cwd,
      prompt: args.prompt,
      model: args.opts?.model,
      modelEffort: args.opts?.modelEffort,
      permissionMode: args.opts?.permissionMode,
      env: args.opts?.env,
      resumeSessionId: args.resumeSessionId,
      onSessionId: bind,
      onEvent: emit,
    })

    captureStderrTail(spawned.stderr, (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP)
    })

    void spawned.ready.catch((err) => {
      if (!bound) rejectHandle(err)
    })

    void spawned.closed.then(({ code, signal }) => {
      if (session) {
        if (!terminalSeen && typeof code === "number" && code !== 0) {
          queue.push({
            type: "error",
            message: formatExitMsg("codex app-server exited", code, signal, stderrTail),
          })
        }
        session.closed = true
        this.notify(session)
        this.registry.unregister(session.sessionId, spawned.proc)
        if (this.running.get(session.sessionId) === session) {
          this.running.delete(session.sessionId)
        }
      }
      if (!bound) {
        rejectHandle(
          new Error(formatExitMsg("codex app-server exited before session id was captured", code, signal, stderrTail)),
        )
      }
    })

    return handlePromise
  }

  private async startExec(args: {
    cwd: string
    prompt: string
    opts?: SpawnOpts
    resumeSessionId?: string
  }): Promise<SessionHandle> {
    const binaryPath = await this.binaryPathResolver()
    const modelId = args.opts?.model ?? codexCapabilities.defaultModelId()
    const spawned = spawnCodexProcess({
      binaryPath,
      cwd: args.cwd,
      prompt: args.prompt,
      model: args.opts?.model,
      modelEffort: args.opts?.modelEffort,
      permissionMode: args.opts?.permissionMode,
      env: args.opts?.env,
      resumeSessionId: args.resumeSessionId,
    })

    let resolveHandle: (h: SessionHandle) => void = () => {}
    let rejectHandle: (e: unknown) => void = () => {}
    const handlePromise = new Promise<SessionHandle>((res, rej) => {
      resolveHandle = res
      rejectHandle = rej
    })

    const queue: EngineEvent[] = []
    let session: RunningSession | undefined
    let bound = false
    let stderrTail = ""
    const contextWindowPromise = resolveOpenRouterContextWindow(modelId)

    // Attach before resume's sync-bind path returns a handle; a fast
    // failing codex can write stderr and exit immediately afterward.
    captureStderrTail(spawned.stderr, (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP)
    })

    const bind = (sessionId: string) => {
      if (bound) {
        // On resume we sync-bind with the caller-supplied sid before
        // codex emits anything. If codex later announces a *different*
        // sid (e.g. forked-to-new-rollout), the handle the caller is
        // already holding points at the wrong session. Surface that
        // loudly so the user sees the divergence instead of silently
        // talking to the wrong rollout.
        if (session && session.sessionId !== sessionId) {
          queue.push({
            type: "error",
            message: `codex resumed to a different session id (got ${sessionId}, expected ${session.sessionId})`,
          })
          this.notify(session)
        }
        return
      }
      bound = true
      session = {
        sessionId,
        cwd: args.cwd,
        spawned,
        queue,
        waiters: [],
        closed: false,
        spawnedAtIso: new Date().toISOString(),
      }
      this.running.set(sessionId, session)
      this.registry.register({
        sessionId,
        cwd: args.cwd,
        proc: spawned.proc,
        startedAt: Date.now(),
        prompt: args.prompt,
      } satisfies ProcessHandle)
      resolveHandle({ sessionId, cwd: args.cwd })
    }

    if (args.resumeSessionId) {
      try {
        bind(args.resumeSessionId)
      } catch (err) {
        try {
          spawned.proc.kill("SIGKILL")
        } catch {
          /* proc already gone */
        }
        rejectHandle(err)
        throw err
      }
    }

    // Materialize exit info as a promise so the parser's finally block
    // can synchronously inspect the exit code *before* closing the
    // session. Without this, the parser's for-await loop ends as soon
    // as stdout EOFs and races ahead of the 'exit' event — the consumer
    // observes session.closed with an empty queue and returns before
    // the error event has been pushed.
    const exitInfo: { code: number | null; signal: NodeJS.Signals | null; seen: boolean } = {
      code: null,
      signal: null,
      seen: false,
    }
    const exitObserved = new Promise<void>((resolve) => {
      spawned.proc.once("exit", (code, signal) => {
        exitInfo.code = code
        exitInfo.signal = signal
        exitInfo.seen = true
        if (!bound) {
          rejectHandle(
            new Error(formatExitMsg("codex exited before session id was captured", code, signal, stderrTail)),
          )
        }
        resolve()
      })
    })

    void (async () => {
      const events = parseStreamJson(readLines(spawned.stdout), {
        onSessionId: (sid) => bind(sid),
        contextWindowTokens: () => contextWindowPromise,
      })
      try {
        for await (const ev of events) {
          queue.push(ev)
          if (session) this.notify(session)
          if ((ev.type === "done" || ev.type === "error") && session) {
            this.registry.unregister(session.sessionId, spawned.proc)
          }
        }
      } catch (err) {
        const ev: EngineEvent = {
          type: "error",
          message: `codex parser failure: ${err instanceof Error ? err.message : String(err)}`,
        }
        queue.push(ev)
        if (session) this.notify(session)
      } finally {
        // Wait briefly for the 'exit' event so we can fold a non-zero
        // exit into the stream as an error event. Timeout cap keeps us
        // from hanging if the process never emits exit (shouldn't
        // happen for child_process, but be defensive).
        await Promise.race([exitObserved, new Promise<void>((r) => setTimeout(r, 500))])
        if (session) {
          const code = exitInfo.code
          const lastEv = queue[queue.length - 1]
          if (exitInfo.seen && typeof code === "number" && code !== 0 && lastEv?.type !== "error") {
            queue.push({
              type: "error",
              message: formatExitMsg("codex exited", code, exitInfo.signal, stderrTail),
            })
          }
          session.closed = true
          this.notify(session)
          this.registry.unregister(session.sessionId, spawned.proc)
          if (this.running.get(session.sessionId) === session) {
            this.running.delete(session.sessionId)
          }
        }
        if (!bound) {
          rejectHandle(new Error("codex exited without emitting a session id"))
        }
      }
    })()

    spawned.proc.once("error", (err) => {
      if (!bound) rejectHandle(err)
    })

    return handlePromise
  }

  private notify(session: RunningSession): void {
    const waiters = session.waiters
    session.waiters = []
    for (const w of waiters) w()
  }
}

const STDERR_TAIL_CAP = 4 * 1024

function captureStderrTail(
  stream: NodeJS.ReadableStream | { on: ChildProcessWithoutNullStreams["stderr"]["on"] },
  onChunk: (text: string) => void,
): void {
  const s = stream as NodeJS.ReadableStream
  s.on("data", (chunk: Buffer | string) => {
    onChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
  })
  s.on("error", () => {})
}

function formatExitMsg(prefix: string, code: number | null, signal: NodeJS.Signals | null, stderrTail: string): string {
  const parts: string[] = [prefix]
  if (typeof code === "number") parts.push(`(code=${code}${signal ? `, signal=${signal}` : ""})`)
  else if (signal) parts.push(`(signal=${signal})`)
  const detail = stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")
  if (detail) parts.push(`: ${detail}`)
  return parts.join(" ").replace(/ : /, ": ")
}
