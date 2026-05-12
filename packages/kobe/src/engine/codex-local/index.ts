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
import { withTotalSpeedForTurn } from "@/session/usage-metrics"
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
import { findCodexBinary } from "./binary"
import { codexCapabilities, codexIdentity } from "./capabilities"
import { deleteHistory as deleteHistoryImpl, readHistoryWithMetrics as readHistoryImpl } from "./history"
import { listSessionsForCwd } from "./sessions"
import { type SpawnedCodex, spawnCodexProcess } from "./spawn"
import { parseStreamJson, readLines } from "./stream"

export interface CodexLocalOpts {
  readonly binaryPathResolver?: () => Promise<string>
  readonly stopGraceMs?: number
}

interface RunningSession {
  readonly sessionId: string
  readonly cwd: string
  readonly spawned: SpawnedCodex
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

  constructor(opts: CodexLocalOpts = {}) {
    this.binaryPathResolver = opts.binaryPathResolver ?? findCodexBinary
    this.stopGraceMs = opts.stopGraceMs ?? 5_000
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
    const binaryPath = await this.binaryPathResolver()
    const spawned = spawnCodexProcess({
      binaryPath,
      cwd: args.cwd,
      prompt: args.prompt,
      model: args.opts?.model,
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

    void (async () => {
      const events = parseStreamJson(readLines(spawned.stdout), {
        onSessionId: (sid) => bind(sid),
      })
      try {
        for await (const ev of events) {
          const enriched = enrichUsageEvent(ev, session?.spawnedAtIso)
          queue.push(enriched)
          if (session) this.notify(session)
        }
      } catch (err) {
        const ev: EngineEvent = {
          type: "error",
          message: `codex parser failure: ${err instanceof Error ? err.message : String(err)}`,
        }
        queue.push(ev)
        if (session) this.notify(session)
      } finally {
        if (session) {
          session.closed = true
          this.notify(session)
          this.registry.unregister(session.sessionId)
          this.running.delete(session.sessionId)
        }
        if (!bound) {
          rejectHandle(new Error("codex exited without emitting a session id"))
        }
      }
    })()

    drainStream(spawned.stderr)

    spawned.proc.once("error", (err) => {
      if (!bound) rejectHandle(err)
    })
    spawned.proc.once("exit", () => {
      if (!bound) {
        rejectHandle(new Error("codex exited before session id was captured"))
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
  const s = stream as NodeJS.ReadableStream
  s.on("data", () => {})
  s.on("error", () => {})
}

function enrichUsageEvent(ev: EngineEvent, startedAtIso: string | undefined): EngineEvent {
  if (ev.type !== "usage") return ev
  return { type: "usage", ...withTotalSpeedForTurn(ev, startedAtIso, new Date().toISOString()) }
}
