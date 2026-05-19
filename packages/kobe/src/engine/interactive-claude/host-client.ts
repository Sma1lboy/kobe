/**
 * kobe-side client for the interactive-claude PTY host.
 *
 * Part of KOB-208. Spawns `node pty-host.cjs` as a child process and
 * speaks the JSON-line IPC defined in {@link ./pty-host.cjs}: commands
 * out on the child's stdin, events in on the child's stdout. Raw PTY
 * bytes never cross this boundary — the transcript JSONL is the source
 * of truth for conversation content (see {@link ./transcript-tail}).
 *
 * The host runs under Node, not Bun: `node-pty`'s `data` callback does
 * not fire under Bun 1.3.11 (KOB-208 spike), so the PTY must live in a
 * real Node process.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { findNodeBinary } from "./node-binary"

/** Events the host emits (host → parent). Mirrors `pty-host.cjs`. */
export type HostEvent =
  | { readonly type: "ready" }
  | { readonly type: "spawned"; readonly pid: number }
  | { readonly type: "session"; readonly sessionId: string; readonly jsonlPath: string }
  | { readonly type: "alive"; readonly pid: number }
  | { readonly type: "exit"; readonly code: number; readonly signal: number }
  | { readonly type: "error"; readonly message: string }

/** Options for {@link HostClient.start}. */
export interface HostStartOpts {
  /** Absolute path to the `claude` binary. */
  readonly claudeBin: string
  /** Working directory for the interactive `claude` REPL. */
  readonly cwd: string
  /** Extra CLI args (e.g. `--model`). `--resume` is added from `resumeSessionId`. */
  readonly args?: readonly string[]
  /** Extra env merged into the claude process env. */
  readonly env?: Readonly<Record<string, string>>
  /** Directory holding `<encoded-cwd>` subdirs — `~/.claude/projects`. */
  readonly projectsDir: string
  /** When set, the host runs `claude --resume <id>` and reports the id directly. */
  readonly resumeSessionId?: string
  /** Override the REPL-ready delay (ms). Default 4000. */
  readonly readyDelayMs?: number
}

/**
 * Resolve the on-disk path to `pty-host.cjs`.
 *
 * In dev, kobe runs from source and the `.cjs` sits next to this
 * module. In a published build the bundler flattens everything into
 * `dist/cli/index.js`, so `scripts/build.ts` copies the host to
 * `dist/share/interactive-claude/pty-host.cjs`; we resolve that
 * relative to the bundle as a fallback.
 */
function resolveHostScript(): string {
  const sibling = fileURLToPath(new URL("./pty-host.cjs", import.meta.url))
  if (existsSync(sibling)) return sibling
  const bundleDir = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.join(bundleDir, "..", "share", "interactive-claude", "pty-host.cjs")
  if (existsSync(bundled)) return bundled
  // Last resort: return the sibling path and let spawn surface ENOENT
  // with an actionable message.
  return sibling
}

/**
 * A live connection to one PTY host child. One host == one interactive
 * `claude` session. Construct, {@link start} it, await {@link onSession},
 * then {@link sendPrompt} per turn. {@link stop} kills the host.
 */
export class HostClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ""
  private readonly listeners = new Set<(ev: HostEvent) => void>()
  private exited = false
  private sessionInfo: { sessionId: string; jsonlPath: string } | null = null

  /** Subscribe to every host event. Returns an unsubscribe function. */
  on(listener: (ev: HostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolves with the session info once the host detects the transcript file. */
  onSession(): Promise<{ sessionId: string; jsonlPath: string }> {
    if (this.sessionInfo) return Promise.resolve(this.sessionInfo)
    return new Promise((resolve, reject) => {
      const off = this.on((ev) => {
        if (ev.type === "session") {
          off()
          resolve({ sessionId: ev.sessionId, jsonlPath: ev.jsonlPath })
        } else if (ev.type === "error") {
          off()
          reject(new Error(`interactive-claude host error: ${ev.message}`))
        } else if (ev.type === "exit") {
          off()
          reject(new Error("interactive-claude host exited before reporting a session"))
        }
      })
    })
  }

  /** True while the host child is running. */
  isAlive(): boolean {
    return this.child !== null && !this.exited
  }

  /** Spawn the host child and send the `start` command. */
  async start(opts: HostStartOpts): Promise<void> {
    if (this.child) throw new Error("HostClient already started")
    const nodeBin = await findNodeBinary()
    const hostScript = resolveHostScript()

    this.child = spawn(nodeBin, [hostScript], {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so a stop signals the whole tree.
      detached: true,
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => this.ingestStdout(chunk))
    // Host log lines go to stderr — surface them on kobe's stderr so a
    // daemon problem lands in daemon.log with context.
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk)
    })
    this.child.on("exit", (code, signal) => {
      if (this.exited) return
      this.exited = true
      this.emit({ type: "exit", code: code ?? 0, signal: signal ? 1 : 0 })
    })
    this.child.on("error", (err) => {
      this.emit({ type: "error", message: `host spawn failed: ${err.message}` })
    })

    // Cache session info as it arrives so late `onSession()` callers resolve.
    this.on((ev) => {
      if (ev.type === "session") this.sessionInfo = { sessionId: ev.sessionId, jsonlPath: ev.jsonlPath }
    })

    this.writeCommand({
      type: "start",
      claudeBin: opts.claudeBin,
      cwd: opts.cwd,
      args: opts.args ?? [],
      env: opts.env ?? {},
      projectsDir: opts.projectsDir,
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(opts.readyDelayMs !== undefined ? { readyDelayMs: opts.readyDelayMs } : {}),
    })
  }

  /** Inject a prompt into the REPL. Queued by the host until the REPL is ready. */
  sendPrompt(text: string): void {
    this.writeCommand({ type: "prompt", text })
  }

  /** Kill the host child and its PTY. Idempotent. */
  stop(): void {
    if (!this.child || this.exited) return
    try {
      this.writeCommand({ type: "stop" })
    } catch {
      /* stdin may already be closed */
    }
    // Backstop: if the host doesn't exit on the command, signal the group.
    const child = this.child
    setTimeout(() => {
      if (!this.exited) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL")
        } catch {
          /* already gone */
        }
      }
    }, 1500).unref?.()
  }

  private writeCommand(cmd: Record<string, unknown>): void {
    if (!this.child || this.exited) return
    try {
      this.child.stdin.write(`${JSON.stringify(cmd)}\n`)
    } catch {
      /* pipe closed — host is gone, callers see it via the exit event */
    }
  }

  private ingestStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl = this.stdoutBuf.indexOf("\n")
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (line) this.parseLine(line)
      nl = this.stdoutBuf.indexOf("\n")
    }
  }

  private parseLine(line: string): void {
    let ev: unknown
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev && typeof ev === "object" && typeof (ev as { type?: unknown }).type === "string") {
      this.emit(ev as HostEvent)
    }
  }

  private emit(ev: HostEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(ev)
      } catch {
        /* a listener throwing must not break fan-out */
      }
    }
  }
}
