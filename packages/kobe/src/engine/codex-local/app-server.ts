import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"
import type { EngineEvent, ModelEffortLevel } from "@/types/engine"
import type { SpawnedCodex } from "./spawn"

export type CodexBackend = "exec" | "app-server"

export interface SpawnCodexAppServerTurnOpts {
  readonly binaryPath: string
  readonly cwd: string
  readonly prompt: string
  readonly model?: string
  readonly modelEffort?: ModelEffortLevel
  readonly resumeSessionId?: string
  readonly permissionMode?: "default" | "plan"
  readonly env?: Readonly<Record<string, string>>
  readonly onSessionId: (sessionId: string) => void
  readonly onEvent: (event: EngineEvent) => void
}

export interface SpawnedCodexAppServer extends SpawnedCodex {
  readonly ready: Promise<string>
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
}

export function resolveCodexBackend(env: NodeJS.ProcessEnv = process.env): CodexBackend {
  if (env.KOBE_CODEX_BACKEND === "app-server" || env.KOBE_CODEX_APP_SERVER === "1") return "app-server"
  return "exec"
}

export function spawnCodexAppServerTurn(opts: SpawnCodexAppServerTurnOpts): SpawnedCodexAppServer {
  const args = buildAppServerArgs(opts)
  const proc = spawn(opts.binaryPath, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams

  const rpc = new AppServerRpc(proc, opts)
  void rpc.run()

  return {
    proc,
    stdout: proc.stdout,
    stderr: proc.stderr,
    args,
    ready: rpc.ready,
    closed: rpc.closed,
  }
}

export function buildAppServerArgs(opts: Pick<SpawnCodexAppServerTurnOpts, "permissionMode">): string[] {
  const mode = permissionPayloads(opts.permissionMode)
  return ["app-server", "-c", `approval_policy="${mode.approvalPolicy}"`, "-c", `sandbox_mode="${mode.threadSandbox}"`]
}

export function codexAppServerUsageToSnapshot(params: unknown): EngineEvent | null {
  const root = asObject(params)
  const tokenUsage = asObject(root?.tokenUsage ?? root?.token_usage)
  const last = asObject(tokenUsage?.last)
  if (!last) return null
  const totalTokens = numberOr(last.totalTokens ?? last.total_tokens, 0)
  const inputTokens = numberOr(last.inputTokens ?? last.input_tokens, 0)
  const cachedInputTokens = numberOr(last.cachedInputTokens ?? last.cached_input_tokens, 0)
  const outputTokens = numberOr(last.outputTokens ?? last.output_tokens, 0)
  const contextWindow = numberOr(tokenUsage?.modelContextWindow ?? tokenUsage?.model_context_window, 0)
  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return null

  return {
    type: "usage",
    input_tokens: Math.max(0, inputTokens - cachedInputTokens),
    output_tokens: outputTokens,
    ...(cachedInputTokens > 0 ? { cache_read_input_tokens: cachedInputTokens } : {}),
    ...(totalTokens > 0 ? { context_tokens: totalTokens } : {}),
    ...(contextWindow > 0 ? { context_window_tokens: contextWindow } : {}),
  }
}

class AppServerRpc {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>()
  private readBuffer = ""
  private nextId = 1
  private readyResolve: (sessionId: string) => void = () => {}
  private readyReject: (err: unknown) => void = () => {}
  readonly ready = new Promise<string>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly opts: SpawnCodexAppServerTurnOpts,
  ) {
    this.closed = new Promise((resolve) => {
      proc.once("exit", (code, signal) => resolve({ code, signal }))
    })
    proc.stdout.setEncoding("utf8")
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    proc.stdout.on("error", () => {})
    proc.stderr.on("error", () => {})
    proc.once("error", (err) => {
      this.readyReject(err)
      this.rejectAll(err)
    })
  }

  async run(): Promise<void> {
    try {
      await this.call("initialize", {
        clientInfo: {
          name: "kobe",
          title: "kobe",
          version: "0.0.0",
        },
        capabilities: { experimentalApi: true },
      })
      this.notify("initialized", undefined)

      const sessionId = this.opts.resumeSessionId
        ? await this.resumeThread(this.opts.resumeSessionId)
        : await this.startThread()
      this.opts.onSessionId(sessionId)
      this.readyResolve(sessionId)
      await this.startTurn(sessionId)
    } catch (err) {
      this.readyReject(err)
      this.opts.onEvent({ type: "error", message: `codex app-server failure: ${stringifyErr(err)}` })
      this.close()
    }
  }

  private async startThread(): Promise<string> {
    const mode = permissionPayloads(this.opts.permissionMode)
    const result = asObject(
      await this.call("thread/start", {
        cwd: this.opts.cwd,
        model: this.opts.model ?? null,
        approvalPolicy: mode.approvalPolicy,
        sandbox: mode.threadSandbox,
        ephemeral: false,
      }),
    )
    const thread = asObject(result?.thread)
    const id = typeof thread?.id === "string" ? thread.id : undefined
    if (!id) throw new Error("thread/start did not return a thread id")
    return id
  }

  private async resumeThread(sessionId: string): Promise<string> {
    const mode = permissionPayloads(this.opts.permissionMode)
    const result = asObject(
      await this.call("thread/resume", {
        threadId: sessionId,
        cwd: this.opts.cwd,
        model: this.opts.model ?? null,
        approvalPolicy: mode.approvalPolicy,
        sandbox: mode.threadSandbox,
      }),
    )
    const thread = asObject(result?.thread)
    const id = typeof thread?.id === "string" ? thread.id : undefined
    if (!id) throw new Error("thread/resume did not return a thread id")
    return id
  }

  private async startTurn(sessionId: string): Promise<void> {
    const mode = permissionPayloads(this.opts.permissionMode)
    await this.call("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: this.opts.prompt, text_elements: [] }],
      cwd: this.opts.cwd,
      model: this.opts.model ?? null,
      effort: this.opts.modelEffort ?? null,
      approvalPolicy: mode.approvalPolicy,
      sandboxPolicy: mode.turnSandboxPolicy,
    })
  }

  private call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    this.send({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  private notify(method: string, params: unknown): void {
    this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params })
  }

  private send(payload: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private onStdout(chunk: string): void {
    this.readBuffer += chunk
    let lineEnd = this.readBuffer.indexOf("\n")
    while (lineEnd !== -1) {
      const line = this.readBuffer.slice(0, lineEnd).trim()
      this.readBuffer = this.readBuffer.slice(lineEnd + 1)
      if (line.length > 0) this.handleLine(line)
      lineEnd = this.readBuffer.indexOf("\n")
    }
  }

  private handleLine(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const record = asObject(msg)
    if (!record) return

    const id = typeof record.id === "number" ? record.id : undefined
    const method = typeof record.method === "string" ? record.method : undefined
    if (id !== undefined && this.pending.has(id)) {
      const pending = this.pending.get(id)
      this.pending.delete(id)
      if (!pending) return
      const error = asObject(record.error)
      if (error)
        pending.reject(new Error(typeof error.message === "string" ? error.message : "app-server request failed"))
      else pending.resolve(record.result)
      return
    }

    if (id !== undefined && method) {
      this.rejectServerRequest(id, method)
      return
    }

    if (!method) return
    this.handleNotification(method, record.params)
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "thread/tokenUsage/updated") {
      const usage = codexAppServerUsageToSnapshot(params)
      if (usage) this.opts.onEvent(usage)
      return
    }
    if (method === "item/agentMessage/delta") {
      const p = asObject(params)
      const text = typeof p?.delta === "string" ? p.delta : typeof p?.text === "string" ? p.text : ""
      if (text) this.opts.onEvent({ type: "assistant.delta", text })
      return
    }
    if (method === "item/started" || method === "item/completed") {
      const p = asObject(params)
      const item = asObject(p?.item)
      const itemType = typeof item?.type === "string" ? item.type : "tool"
      if (itemType === "agentMessage" || itemType === "agent_message") return
      const payload = stripItemHousekeeping(item ?? {})
      if (method === "item/started") this.opts.onEvent({ type: "tool.start", name: itemType, input: payload })
      else this.opts.onEvent({ type: "tool.result", name: itemType, output: payload })
      return
    }
    if (method === "turn/completed") {
      const p = asObject(params)
      const turn = asObject(p?.turn)
      const error = turn?.error
      if (error) {
        this.opts.onEvent({ type: "error", message: stringifyErr(error) })
      } else {
        this.opts.onEvent({ type: "done" })
      }
      this.close()
      return
    }
    if (method === "error") {
      const p = asObject(params)
      const message = typeof p?.message === "string" ? p.message : "codex app-server emitted an error"
      this.opts.onEvent({ type: "error", message })
      this.close()
    }
  }

  private rejectServerRequest(id: number, method: string): void {
    this.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: `kobe app-server backend does not handle server request ${method}`,
      },
    })
  }

  private close(): void {
    try {
      this.proc.stdin.end()
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      if (!this.proc.killed) {
        try {
          this.proc.kill("SIGTERM")
        } catch {
          /* already gone */
        }
      }
    }, 50).unref()
  }

  private rejectAll(err: unknown): void {
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
  }
}

function permissionPayloads(mode: "default" | "plan" | undefined): {
  readonly approvalPolicy: "never"
  readonly threadSandbox: "read-only" | "danger-full-access"
  readonly turnSandboxPolicy:
    | { readonly type: "readOnly"; readonly networkAccess: boolean }
    | { readonly type: "dangerFullAccess" }
} {
  if (mode === "plan") {
    return {
      approvalPolicy: "never",
      threadSandbox: "read-only",
      turnSandboxPolicy: { type: "readOnly", networkAccess: true },
    }
  }
  return {
    approvalPolicy: "never",
    threadSandbox: "danger-full-access",
    turnSandboxPolicy: { type: "dangerFullAccess" },
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function stripItemHousekeeping(item: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, type: _type, ...rest } = item
  return rest
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
