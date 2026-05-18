import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type {
  AIEngine,
  EngineCapabilities,
  EngineCommandDiscoveryOpts,
  EngineCommandEntry,
  EngineEvent,
  EngineHistory,
  EngineIdentity,
  SessionHandle,
  SessionMeta,
  SpawnOpts,
} from "@/types/engine"
import { type ProcessHandle, SessionRegistry } from "../claude-code-local/registry"
import { findGeminiBinary } from "./binary"
import { geminiCapabilities, geminiIdentity } from "./capabilities"
import { deleteHistory as deleteHistoryImpl, readHistoryWithMetrics as readHistoryImpl } from "./history"
import { listSessionsForCwd } from "./sessions"
import { type SpawnedGemini, spawnGeminiProcess } from "./spawn"
import { parseStreamJson, readLines } from "./stream"

export interface GeminiLocalOpts {
  readonly binaryPathResolver?: () => Promise<string>
  readonly stopGraceMs?: number
}

interface RunningSession {
  readonly sessionId: string
  readonly cwd: string
  readonly spawned: SpawnedGemini
  readonly queue: EngineEvent[]
  waiters: Array<() => void>
  closed: boolean
}

export class GeminiLocal implements AIEngine {
  readonly identity: EngineIdentity = geminiIdentity
  readonly capabilities: EngineCapabilities = geminiCapabilities
  private readonly registry = new SessionRegistry()
  private readonly running = new Map<string, RunningSession>()
  private readonly binaryPathResolver: () => Promise<string>
  private readonly stopGraceMs: number

  constructor(opts: GeminiLocalOpts = {}) {
    this.binaryPathResolver = opts.binaryPathResolver ?? findGeminiBinary
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

  async listCommands(_opts?: EngineCommandDiscoveryOpts): Promise<readonly EngineCommandEntry[]> {
    return []
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

  private async start(args: {
    cwd: string
    prompt: string
    opts?: SpawnOpts
    resumeSessionId?: string
  }): Promise<SessionHandle> {
    const binaryPath = await this.binaryPathResolver()
    const spawned = spawnGeminiProcess({
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
    let stderrTail = ""
    let terminalSeen = false

    captureStderrTail(spawned.stderr, (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP)
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
        if (!bound)
          rejectHandle(
            new Error(formatExitMsg("gemini exited before session id was captured", code, signal, stderrTail)),
          )
        resolve()
      })
    })

    void (async () => {
      try {
        for await (const ev of parseStreamJson(readLines(spawned.stdout), { onSessionId: bind })) {
          if (ev.type === "done" || ev.type === "error") terminalSeen = true
          queue.push(ev)
          if (session) this.notify(session)
          if ((ev.type === "done" || ev.type === "error") && session) {
            this.registry.unregister(session.sessionId, spawned.proc)
          }
        }
      } catch (err) {
        queue.push({
          type: "error",
          message: `gemini parser failure: ${err instanceof Error ? err.message : String(err)}`,
        })
        if (session) this.notify(session)
      } finally {
        // stdout can close before the child emits exit; keep cleanup bounded.
        await Promise.race([exitObserved, new Promise<void>((r) => setTimeout(r, PROCESS_EXIT_GRACE_MS))])
        if (session) {
          const lastEv = queue[queue.length - 1]
          if (
            exitInfo.seen &&
            typeof exitInfo.code === "number" &&
            exitInfo.code !== 0 &&
            !terminalSeen &&
            lastEv?.type !== "error"
          ) {
            queue.push({
              type: "error",
              message: formatExitMsg("gemini exited", exitInfo.code, exitInfo.signal, stderrTail),
            })
          }
          session.closed = true
          this.notify(session)
          this.registry.unregister(session.sessionId, spawned.proc)
          if (this.running.get(session.sessionId) === session) this.running.delete(session.sessionId)
        }
        if (!bound) rejectHandle(new Error("gemini exited without emitting a session id"))
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
const PROCESS_EXIT_GRACE_MS = 500

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
