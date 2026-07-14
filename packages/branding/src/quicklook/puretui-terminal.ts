import { chmod, mkdir } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import type { CaptureTerminal } from "./capture-core"
import type { SeedTask } from "./replay-spec"

export type SidecarSpawnOptions = {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface SidecarProcess {
  stdin: { write(chunk: string | Uint8Array): void; end(): void }
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

export type SidecarFactory = (options: SidecarSpawnOptions) => SidecarProcess

export type PureTuiCaptureOptions = {
  repoRoot: string
  demoRoot: string
  fixtureRepo: string
  seedTasks?: readonly SeedTask[]
  cols: number
  rows: number
  protocolTimeoutMs?: number
  sidecarExitTimeoutMs?: number
  sidecarPath?: string
  sidecarFactory?: SidecarFactory
}

type SidecarError = { message: string; snapshot?: string; pid?: number; demoRoot?: string }
type SidecarResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: SidecarError }
type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

type Diagnostics = { snapshot: string; pid?: number; demoRoot: string }

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("KOBE_") &&
        key !== "HOME" &&
        key !== "USERPROFILE" &&
        !key.startsWith("XDG_") &&
        key !== "TERM" &&
        key !== "TERM_PROGRAM" &&
        key !== "TERM_PROGRAM_VERSION" &&
        key !== "COLORTERM",
    ),
  ) as Record<string, string>

const capturePort = (demoRoot: string): string => {
  let hash = 2166136261
  for (const char of demoRoot) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return String(30_000 + (hash % 15_000))
}

const captureEnvironment = (demoRoot: string): Record<string, string> => {
  const home = join(demoRoot, "home")
  return {
    ...inheritedEnvironment(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: join(home, ".runtime"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "kobe-capture",
    KOBE_HOME_DIR: home,
    KOBE_SANDBOX_HOME_DIR: home,
    KOBE_DAEMON_WEB_PORT: capturePort(demoRoot),
    KOBE_CAPTURE_HOST_LABEL: "puretui-replay",
    KOBE_CAPTURE_SESSION_LABEL: basename(demoRoot),
  }
}

const defaultSidecarFactory: SidecarFactory = ({ file, args, cwd, env }) => {
  const child = Bun.spawn([file, ...args], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    stdin: {
      write: (chunk) => child.stdin.write(chunk),
      end: () => child.stdin.end(),
    },
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  }
}

const formatDiagnostics = (message: string, diagnostics: Diagnostics): Error =>
  new Error(
    [
      message,
      `child pid: ${diagnostics.pid ?? "not started"}`,
      `demo root: ${diagnostics.demoRoot}`,
      `latest ANSI snapshot:\n${diagnostics.snapshot || "<empty>"}`,
    ].join("\n"),
  )

const updateDiagnostics = (diagnostics: Diagnostics, value: unknown) => {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  if (typeof record.pid === "number") diagnostics.pid = record.pid
  if (typeof record.demoRoot === "string") diagnostics.demoRoot = record.demoRoot
  if (typeof record.snapshot === "string") diagnostics.snapshot = record.snapshot
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) diagnostics.snapshot = value.join("\n")
}

class JsonLineSidecarClient {
  private id = 0
  private readonly pending = new Map<number, PendingRequest>()
  private stderr = ""

  constructor(
    private readonly process: SidecarProcess,
    private readonly timeoutMs: number,
    private readonly diagnostics: Diagnostics,
  ) {
    void this.readResponses()
    void this.readStderr()
    void process.exited.then((code) => {
      if (this.pending.size === 0) return
      this.failAll(formatDiagnostics(`PureTUI sidecar exited with code ${code}${this.stderr ? `: ${this.stderr}` : ""}`, diagnostics))
    })
  }

  async request(op: string, fields: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    const id = ++this.id
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(formatDiagnostics(`PureTUI sidecar ${op} request timed out after ${timeoutMs}ms`, this.diagnostics))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
    })
    this.process.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`)
    return promise
  }

  closeInput() {
    this.process.stdin.end()
  }

  private async readResponses() {
    await this.readLines(this.process.stdout, (line) => {
      let response: SidecarResponse
      try {
        response = JSON.parse(line) as SidecarResponse
      } catch {
        this.failAll(formatDiagnostics(`PureTUI sidecar emitted invalid JSON: ${line}`, this.diagnostics))
        return
      }
      const pending = this.pending.get(response.id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(response.id)
      if (response.ok) {
        updateDiagnostics(this.diagnostics, response.value)
        pending.resolve(response.value)
        return
      }
      updateDiagnostics(this.diagnostics, response.error)
      pending.reject(
        formatDiagnostics(response.error.message, {
          snapshot: response.error.snapshot ?? this.diagnostics.snapshot,
          pid: response.error.pid ?? this.diagnostics.pid,
          demoRoot: response.error.demoRoot ?? this.diagnostics.demoRoot,
        }),
      )
    })
  }

  private async readStderr() {
    await this.readLines(this.process.stderr, (line) => {
      this.stderr = `${this.stderr}\n${line}`.trim().slice(-8_192)
    })
  }

  private async readLines(stream: ReadableStream<Uint8Array>, consume: (line: string) => void) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      for (;;) {
        const newline = buffered.indexOf("\n")
        if (newline < 0) break
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line) consume(line)
      }
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export class PureTuiTerminal implements CaptureTerminal {
  private started = false
  private stopped = false

  constructor(
    private readonly client: JsonLineSidecarClient,
    private readonly options: Pick<
      PureTuiCaptureOptions,
      "repoRoot" | "demoRoot" | "fixtureRepo" | "seedTasks" | "cols" | "rows"
    >,
  ) {}

  async start() {
    if (this.started) return
    await this.client.request("start", this.options)
    this.started = true
  }

  async snapshot(): Promise<readonly string[]> {
    return (await this.client.request("snapshot")) as string[]
  }

  async type(text: string) {
    await this.client.request("type", { text })
  }

  async key(key: string) {
    await this.client.request("key", { key })
  }

  async waitFor(pattern: string, timeoutMs: number) {
    await this.client.request("waitFor", { pattern, timeoutMs }, timeoutMs + this.options.rows * 10 + 1_000)
  }

  async stop() {
    if (this.stopped) return
    await this.client.request("stop")
    this.stopped = true
  }
}

export async function createPureTuiCapture(options: PureTuiCaptureOptions): Promise<{
  terminal: CaptureTerminal
  cleanup(): Promise<void>
  demoRoot: string
}> {
  const repoRoot = resolve(options.repoRoot)
  const demoRoot = resolve(options.demoRoot)
  const fixtureRepo = resolve(options.fixtureRepo)
  const env = captureEnvironment(demoRoot)
  await Promise.all(
    [demoRoot, env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.XDG_RUNTIME_DIR].map(
      (path) => mkdir(path, { recursive: true }),
    ),
  )
  await chmod(env.XDG_RUNTIME_DIR, 0o700)
  const sidecarPath = options.sidecarPath ?? join(import.meta.dirname, "../../scripts/puretui-pty-sidecar.mjs")
  const process = (options.sidecarFactory ?? defaultSidecarFactory)({
    file: "node",
    args: [sidecarPath],
    cwd: repoRoot,
    env,
  })
  const diagnostics: Diagnostics = { snapshot: "", demoRoot }
  const client = new JsonLineSidecarClient(process, options.protocolTimeoutMs ?? 30_000, diagnostics)
  const terminal = new PureTuiTerminal(client, { ...options, repoRoot, demoRoot, fixtureRepo })
  let cleaned = false
  return {
    terminal,
    demoRoot,
    cleanup: async () => {
      if (cleaned) return
      cleaned = true
      let failure: unknown
      try {
        await terminal.stop()
      } catch (error) {
        failure = error
      }
      client.closeInput()
      let code = await Promise.race([
        process.exited,
        new Promise<undefined>((resolveTimeout) =>
          setTimeout(resolveTimeout, options.sidecarExitTimeoutMs ?? 2_000),
        ),
      ])
      if (code === undefined) {
        process.kill("SIGTERM")
        code = await process.exited
      }
      if (failure) throw failure
      if (code !== 0) throw formatDiagnostics(`PureTUI sidecar exited with code ${code}`, diagnostics)
    },
  }
}
