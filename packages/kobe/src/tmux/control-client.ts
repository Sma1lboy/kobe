/**
 * Long-lived `tmux -C` ("control mode") subprocess client.
 *
 * Owns a single tmux child process, wires its stdout into
 * `TmuxProtocolParser`, exposes a Promise-based command queue
 * (`send()` plus typed helpers like `splitWindow()`), and re-emits
 * parser notifications as typed EventEmitter events.
 *
 * Why `-C` and not `-CC`: both spawn control mode; `-CC` additionally
 * disables echo for nested tmux/iTerm2 integration. Empirically, on
 * macOS tmux 3.5a, `-CC` over plain pipes fails with
 * `tcgetattr failed: Inappropriate ioctl for device` and silently
 * exits — it expects a real TTY for the echo-suppression handshake.
 * Single `-C` runs cleanly with `stdio: ["pipe","pipe","pipe"]`,
 * emits the same protocol, and is sufficient because a programmatic
 * client never reads its own input back from tmux. The bootstrap
 * pane attaches to a `kobe-<id>` session that this client only
 * controls; we don't share a terminal with it.
 *
 * Lifecycle this sprint: one-shot spawn-and-own. No reconnect or
 * crash-recovery here — the daemon-wiring sprint that follows will
 * add that layer on top. When the child dies for any reason we
 * surface `exit` (with reason text, if any) and then `close`.
 *
 * Command/response matching: we use a FIFO queue, not the
 * tmux-assigned `<command-number>`. tmux emits `%begin/%end` blocks
 * in the same order it received the commands on stdin, and the
 * connection handshake itself can emit an unsolicited `%begin/%end`
 * (command-number 0) before the first user send. A FIFO queue gives
 * each `send()` call the *next* response block while letting us drop
 * unsolicited blocks safely — there's no need for our code to predict
 * tmux's internal numbering, and any future protocol change to the
 * starting number won't desync us. We attach the command-number we
 * observe from `%begin` onto the resolved/rejected promise's metadata
 * for callers that want to log it.
 *
 * Stderr ring buffer: tmux occasionally writes diagnostic lines on
 * stderr (e.g. "server not started"). Without buffering them, a
 * promise rejection on `%error` carries only the body line and not
 * the surrounding context. We keep the last few stderr lines and
 * include them in rejected-promise error messages and the `exit`
 * event reason.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { type TmuxEvent, TmuxProtocolParser } from "./protocol-parser.ts"

export interface SpawnControlClientOptions {
  readonly session: string
  readonly tmuxBin?: string
  readonly createIfMissing?: boolean
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stderrRingSize?: number
}

export interface SplitWindowOptions {
  readonly target?: string
  readonly direction?: "h" | "v"
  readonly size?: string | number
  readonly command?: string
  readonly detached?: boolean
  /**
   * When set, runs `split-window -P -F <printFormat>` so the response
   * body carries the new pane's id (or any other tmux format string).
   * Used by `PaneStashAdapter` to recover `%N` ids for the stash map.
   */
  readonly printFormat?: string
}

export interface BreakPaneOptions {
  readonly source: string
  readonly target?: string
  readonly detached?: boolean
}

export interface JoinPaneOptions {
  readonly source: string
  readonly target: string
  readonly horizontal?: boolean
  readonly size?: string | number
}

export interface SwapPaneOptions {
  readonly source: string
  readonly target: string
  /** `-d`: stay on the currently focused pane after the swap. */
  readonly detached?: boolean
}

export interface SelectLayoutOptions {
  readonly target?: string
  readonly layout: string
}

export interface NewWindowOptions {
  readonly target?: string
  readonly windowName?: string
  readonly command?: string
  readonly detached?: boolean
}

export interface KillWindowOptions {
  readonly target: string
}

export interface KillPaneOptions {
  readonly target: string
}

export interface ResizePaneOptions {
  readonly target: string
  readonly width?: number
  readonly height?: number
}

export interface SelectPaneOptions {
  readonly target: string
}

export interface ListPanesOptions {
  readonly target?: string
  readonly format?: string
  readonly allSessions?: boolean
}

export interface ListWindowsOptions {
  readonly target?: string
  readonly format?: string
  readonly allSessions?: boolean
}

export interface DisplayMessageOptions {
  readonly target?: string
  readonly message: string
}

interface PendingSend {
  readonly cmdLine: string
  readonly resolve: (body: string[]) => void
  readonly reject: (err: Error) => void
}

export interface ControlClientErrorMeta {
  readonly commandNumber: number
  readonly cmdLine: string
  readonly body: readonly string[]
  readonly stderr: string
}

export class TmuxCommandError extends Error {
  readonly commandNumber: number
  readonly cmdLine: string
  readonly body: readonly string[]
  readonly stderr: string

  constructor(meta: ControlClientErrorMeta) {
    const summary = meta.body.length > 0 ? meta.body.join(" / ") : "tmux command failed"
    super(`tmux command failed: ${meta.cmdLine.trim()} — ${summary}`)
    this.name = "TmuxCommandError"
    this.commandNumber = meta.commandNumber
    this.cmdLine = meta.cmdLine
    this.body = meta.body
    this.stderr = meta.stderr
  }
}

export class TmuxControlClient extends EventEmitter {
  private child: ChildProcess | null = null
  private parser = new TmuxProtocolParser()
  private pending: PendingSend[] = []
  private stderrRing: string[] = []
  private stderrRingSize: number
  private stderrTail = ""
  private closed = false
  private exited = false
  private spawnError: Error | null = null
  private handshakeSeen = false
  private handshakeWaiters: Array<() => void> = []

  constructor(private opts: SpawnControlClientOptions) {
    super()
    this.stderrRingSize = opts.stderrRingSize ?? 16
  }

  /**
   * Spawn the tmux subprocess. Returns once the child is `spawn`-ed
   * and stdio is wired; protocol activity is asynchronous afterwards.
   */
  async start(): Promise<void> {
    if (this.child) throw new Error("TmuxControlClient: already started")
    const bin = this.opts.tmuxBin ?? "tmux"
    const args = this.opts.createIfMissing
      ? ["-C", "new-session", "-A", "-s", this.opts.session]
      : ["-C", "attach-session", "-t", this.opts.session]
    const child = nodeSpawn(bin, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    this.wireChild(child)
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError)
        resolve()
      }
      const onError = (err: Error): void => {
        child.off("spawn", onSpawn)
        this.spawnError = err
        reject(err)
      }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })
    // tmux emits an unsolicited %begin/%end block (typically command
    // number 0) immediately after the control connection is up. If we
    // let user `send()` calls race that handshake, the first send's
    // pending promise consumes the handshake response and the real
    // response gets dropped as "unsolicited". Block start() until the
    // handshake has been observed so the queue starts coherent.
    await this.waitForHandshake()
  }

  private waitForHandshake(): Promise<void> {
    if (this.handshakeSeen || this.exited) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.handshakeWaiters.push(resolve)
    })
  }

  /**
   * Attach this client to a child that was constructed externally —
   * used by tests with a fake child. Tests rarely simulate the real
   * tmux handshake, so by default we mark it as already-seen; pass
   * `expectHandshake: true` if your fixture intentionally drives the
   * handshake itself.
   */
  attachTo(child: ChildProcess, opts: { expectHandshake?: boolean } = {}): void {
    if (this.child) throw new Error("TmuxControlClient: already attached")
    this.child = child
    if (!opts.expectHandshake) this.handshakeSeen = true
    this.wireChild(child)
  }

  /**
   * Send a tmux command. The args list is joined with spaces and
   * terminated by `\n` (tmux's control-mode line delimiter). Returns
   * a promise that resolves with the body lines from `%end`, or
   * rejects with `TmuxCommandError` on `%error`.
   */
  send(...args: string[]): Promise<string[]> {
    if (this.closed || this.exited) {
      return Promise.reject(new Error("TmuxControlClient: child is closed"))
    }
    if (!this.child || !this.child.stdin) {
      return Promise.reject(new Error("TmuxControlClient: not started"))
    }
    const cmdLine = `${args.map(tmuxQuote).join(" ")}\n`
    return new Promise<string[]>((resolve, reject) => {
      this.pending.push({ cmdLine, resolve, reject })
      this.child?.stdin?.write(cmdLine)
    })
  }

  // ------- typed helpers -------

  splitWindow(opts: SplitWindowOptions = {}): Promise<string[]> {
    const argv: string[] = ["split-window"]
    if (opts.direction === "h") argv.push("-h")
    else if (opts.direction === "v") argv.push("-v")
    if (opts.size !== undefined) argv.push("-l", String(opts.size))
    if (opts.detached) argv.push("-d")
    if (opts.printFormat) argv.push("-P", "-F", opts.printFormat)
    if (opts.target) argv.push("-t", opts.target)
    if (opts.command) argv.push(opts.command)
    return this.send(...argv)
  }

  breakPane(opts: BreakPaneOptions): Promise<string[]> {
    const argv: string[] = ["break-pane"]
    if (opts.detached) argv.push("-d")
    argv.push("-s", opts.source)
    if (opts.target) argv.push("-t", opts.target)
    return this.send(...argv)
  }

  joinPane(opts: JoinPaneOptions): Promise<string[]> {
    const argv: string[] = ["join-pane"]
    if (opts.horizontal) argv.push("-h")
    if (opts.size !== undefined) argv.push("-l", String(opts.size))
    argv.push("-s", opts.source, "-t", opts.target)
    return this.send(...argv)
  }

  swapPane(opts: SwapPaneOptions): Promise<string[]> {
    const argv: string[] = ["swap-pane"]
    if (opts.detached) argv.push("-d")
    argv.push("-s", opts.source, "-t", opts.target)
    return this.send(...argv)
  }

  selectLayout(opts: SelectLayoutOptions): Promise<string[]> {
    const argv: string[] = ["select-layout"]
    if (opts.target) argv.push("-t", opts.target)
    argv.push(opts.layout)
    return this.send(...argv)
  }

  newWindow(opts: NewWindowOptions = {}): Promise<string[]> {
    const argv: string[] = ["new-window"]
    if (opts.detached) argv.push("-d")
    if (opts.target) argv.push("-t", opts.target)
    if (opts.windowName) argv.push("-n", opts.windowName)
    if (opts.command) argv.push(opts.command)
    return this.send(...argv)
  }

  killWindow(opts: KillWindowOptions): Promise<string[]> {
    return this.send("kill-window", "-t", opts.target)
  }

  killPane(opts: KillPaneOptions): Promise<string[]> {
    return this.send("kill-pane", "-t", opts.target)
  }

  resizePane(opts: ResizePaneOptions): Promise<string[]> {
    const argv: string[] = ["resize-pane", "-t", opts.target]
    if (opts.width !== undefined) argv.push("-x", String(opts.width))
    if (opts.height !== undefined) argv.push("-y", String(opts.height))
    return this.send(...argv)
  }

  selectPane(opts: SelectPaneOptions): Promise<string[]> {
    return this.send("select-pane", "-t", opts.target)
  }

  async listPanes(opts: ListPanesOptions = {}): Promise<string[]> {
    const argv: string[] = ["list-panes"]
    if (opts.allSessions) argv.push("-a")
    if (opts.target) argv.push("-t", opts.target)
    if (opts.format) argv.push("-F", opts.format)
    return this.send(...argv)
  }

  async listWindows(opts: ListWindowsOptions = {}): Promise<string[]> {
    const argv: string[] = ["list-windows"]
    if (opts.allSessions) argv.push("-a")
    if (opts.target) argv.push("-t", opts.target)
    if (opts.format) argv.push("-F", opts.format)
    return this.send(...argv)
  }

  displayMessage(opts: DisplayMessageOptions): Promise<string[]> {
    const argv: string[] = ["display-message"]
    if (opts.target) argv.push("-t", opts.target)
    argv.push(opts.message)
    return this.send(...argv)
  }

  killSession(name?: string): Promise<string[]> {
    const argv: string[] = ["kill-session"]
    if (name) argv.push("-t", name)
    return this.send(...argv)
  }

  /**
   * Detach this control client gracefully, then SIGTERM if the child
   * is still alive after a short grace period. Safe to call multiple
   * times. Resolves once the child has exited (or has been signalled).
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.child
    if (!child) return
    if (child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write("detach-client\n")
      } catch {
        /* ignore — stdin may already be closed by tmux side */
      }
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
    }
    if (this.exited) return
    await new Promise<void>((resolve) => {
      const onClose = (): void => {
        clearTimeout(killTimer)
        resolve()
      }
      const killTimer = setTimeout(() => {
        if (!this.exited && child && !child.killed) {
          try {
            child.kill("SIGTERM")
          } catch {
            /* ignore */
          }
        }
      }, 500)
      child.once("close", onClose)
      child.once("exit", onClose)
    })
  }

  dispose(): Promise<void> {
    return this.close()
  }

  /** Latest stderr buffer contents joined with `\n`, useful for diagnostics. */
  stderrSnapshot(): string {
    return [...this.stderrRing, this.stderrTail].filter((s) => s.length > 0).join("\n")
  }

  private wireChild(child: ChildProcess): void {
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk))
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk))
    }
    child.on("exit", (code, signal) => this.handleChildExit(code, signal))
    child.on("error", (err) => this.emit("error", err))
  }

  private handleStdout(chunk: Buffer): void {
    const events = this.parser.feed(chunk)
    for (const ev of events) this.dispatchEvent(ev)
  }

  private handleStderr(chunk: Buffer): void {
    this.stderrTail += chunk.toString("utf8")
    while (true) {
      const i = this.stderrTail.indexOf("\n")
      if (i < 0) break
      const line = this.stderrTail.slice(0, i)
      this.stderrTail = this.stderrTail.slice(i + 1)
      if (line.length === 0) continue
      this.stderrRing.push(line)
      while (this.stderrRing.length > this.stderrRingSize) this.stderrRing.shift()
    }
  }

  private dispatchEvent(ev: TmuxEvent): void {
    if (ev.type === "response") {
      if (!this.handshakeSeen) {
        this.handshakeSeen = true
        for (const w of this.handshakeWaiters.splice(0)) w()
        this.emit("handshake", ev)
        return
      }
      const next = this.pending.shift()
      if (!next) {
        this.emit("unsolicited-response", ev)
        return
      }
      if (ev.success) {
        next.resolve([...ev.body])
      } else {
        next.reject(
          new TmuxCommandError({
            commandNumber: ev.commandNumber,
            cmdLine: next.cmdLine,
            body: ev.body,
            stderr: this.stderrSnapshot(),
          }),
        )
      }
      this.emit("response", ev)
      return
    }
    this.emit(ev.type, ev)
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    const reason = signal ? `signal ${signal}` : code !== null ? `exit ${code}` : "unknown"
    for (const p of this.pending.splice(0)) {
      p.reject(
        new TmuxCommandError({
          commandNumber: 0,
          cmdLine: p.cmdLine,
          body: [`tmux exited before response (${reason})`],
          stderr: this.stderrSnapshot(),
        }),
      )
    }
    this.emit("close", { code, signal, reason, stderr: this.stderrSnapshot() })
  }
}

/** Convenience factory mirroring `node:child_process.spawn`'s shape. */
export async function spawnControlClient(opts: SpawnControlClientOptions): Promise<TmuxControlClient> {
  const client = new TmuxControlClient(opts)
  await client.start()
  return client
}

const SAFE_ARG = /^[A-Za-z0-9_./@%:=,+\-]+$/

function tmuxQuote(s: string): string {
  if (s.length === 0) return '""'
  if (SAFE_ARG.test(s)) return s
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`
}
