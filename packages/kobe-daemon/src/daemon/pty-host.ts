/**
 * PtyHost — daemon-hosted PTY sessions (protocol v4).
 *
 * The tmux-persistence replacement for the embedded terminal: the daemon
 * owns the raw PTY child (`Bun.spawn(..., { terminal })`) plus a capped
 * byte ring buffer per session key, so an engine session keeps running
 * when the TUI exits and replays its screen when a TUI reattaches. VT
 * emulation stays in the TUI (xterm-headless) — this module never parses
 * escape codes, it only moves bytes.
 *
 * Delivery model: TARGETED, not pub/sub. Each session tracks the
 * connections attached to it; output goes only to those sinks as
 * `pty.data` event frames. PTY frames must never be dropped or reordered
 * (a lost chunk corrupts the client's VT state) — server.ts marks them
 * critical for the ClientWriter.
 *
 * Lifecycle: hosted by the standalone `kobe pty-host` process
 * (`pty-server.ts`), NOT the daemon — so `kobe daemon restart` (routine
 * after code changes) never touches running sessions, exactly like the
 * tmux server outliving everything. An exited session is kept, scrollback
 * intact, so a reattach can still show how the child died; it is removed
 * by an explicit `kill` or the task-archive sweep (`sweepTasks`). Only
 * the host process ending (idle-exit at zero live sessions, or
 * `kobe reset`) ends the children.
 */

import { StringDecoder } from "node:string_decoder"
import type { DaemonFrame } from "./protocol.ts"
import { embeddedTerminalEnv } from "./pty-env.js"

/** Everything `pty.open` needs to spawn a session's child on first open. */
export interface PtySpawnSpec {
  readonly cwd: string
  /** Explicit argv (engine sessions). Falls back to `shell`. */
  readonly command?: readonly string[]
  /** Shell override; defaults to the daemon's `$SHELL` or /bin/bash. */
  readonly shell?: string
  readonly cols: number
  readonly rows: number
}

/** Attach result — mirrors the wire `PtyOpenResult`. */
export interface PtyAttachResult {
  readonly replay: string
  readonly alive: boolean
  /** The session child's pid (null when spawn failed) — see `PtyOpenResult.pid`. */
  readonly pid: number | null
}

/** Writes one event frame to an attached connection. */
export type PtySink = (frame: DaemonFrame) => void

export interface PtyHostOptions {
  /** A session's child spawned — cancels a pending daemon idle-stop grace. */
  readonly onSessionStart?: () => void
  /** A session's child ended — may arm the idle-stop grace. */
  readonly onSessionEnd?: () => void
  /** Ring-buffer cap in bytes per session. Default {@link DEFAULT_SCROLLBACK_CAP}. */
  readonly scrollbackCap?: number
  readonly log?: (event: string, message: string) => void
}

/** Per-session scrollback cap — same order as the web PTY sidecar's 256KB. */
export const DEFAULT_SCROLLBACK_CAP = 512 * 1024

/** One session's inventory row — what `pty.list` reports. */
export interface PtySessionInfo {
  readonly key: string
  readonly alive: boolean
  readonly pid: number | null
  readonly command: readonly string[]
  /** Last OSC 0/2 window title the child set ("" until it sets one) —
   *  the live foreground-process name, same stream the TUI tab strip reads. */
  readonly title: string
}

interface PtySessionState {
  readonly key: string
  proc: ReturnType<typeof Bun.spawn> | null
  alive: boolean
  chunks: Buffer[]
  bytes: number
  cols: number
  rows: number
  readonly command: readonly string[]
  title: string
  /** Unterminated escape tail carried between chunks for the title scan. */
  titleCarry: string
  /** UTF-8 decoder for the title scan (a multibyte title may split across chunks). */
  readonly titleDecoder: StringDecoder
  /** Attached connections, keyed by connection identity (the server's ClientState). */
  readonly sinks: Map<object, PtySink>
}

/** A complete OSC 0/2 window-title sequence (BEL- or ST-terminated). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the raw ESC/BEL title wire encoding is the whole point
const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
/** Titles are short — a longer carry isn't an in-progress title sequence. */
const TITLE_CARRY_CAP = 1024

export class PtyHost {
  private readonly sessions = new Map<string, PtySessionState>()
  private readonly opts: PtyHostOptions

  constructor(opts: PtyHostOptions = {}) {
    this.opts = opts
  }

  /**
   * Attach `token`'s connection to the session for `key`, spawning the
   * child on first open. On reattach the spawn spec is IGNORED (the
   * session already runs); the caller gets the ring-buffer replay either
   * way. A fresh TUI can therefore always pass its would-be spawn command
   * — an existing background session simply wins.
   */
  open(key: string, spec: PtySpawnSpec, token: object, sink: PtySink): PtyAttachResult {
    let session = this.sessions.get(key)
    if (!session) {
      session = this.spawn(key, spec)
      this.sessions.set(key, session)
    } else if (session.alive && (session.cols !== spec.cols || session.rows !== spec.rows)) {
      // Reattach from a differently-sized client: last-attach-wins, like
      // tmux — the SIGWINCH makes a full-screen app repaint at the new
      // size, fixing what the stale-size replay painted.
      this.resize(key, spec.cols, spec.rows)
    }
    session.sinks.set(token, sink)
    return {
      replay: Buffer.concat(session.chunks).toString("base64"),
      alive: session.alive,
      pid: session.proc?.pid ?? null,
    }
  }

  /** Forward client input (already UTF-8 text from xterm) to the child. */
  write(key: string, data: string): void {
    const session = this.sessions.get(key)
    if (!session?.alive || data.length === 0) return
    try {
      session.proc?.terminal?.write(data)
    } catch {
      this.markExited(session)
    }
  }

  resize(key: string, cols: number, rows: number): void {
    const session = this.sessions.get(key)
    if (!session?.alive) return
    session.cols = cols
    session.rows = rows
    try {
      session.proc?.terminal?.resize(cols, rows)
    } catch {
      this.markExited(session)
    }
  }

  /** End the child AND forget the session (explicit close / archive). */
  kill(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    this.endChild(session)
  }

  /** Detach one connection from one session; the child keeps running. */
  detach(key: string, token: object): void {
    this.sessions.get(key)?.sinks.delete(token)
  }

  /** Detach one connection from EVERY session (socket closed). */
  detachClient(token: object): void {
    for (const session of this.sessions.values()) session.sinks.delete(token)
  }

  /** Session inventory — lets a fresh TUI discover background sessions. */
  list(): PtySessionInfo[] {
    return Array.from(this.sessions.values(), (s) => ({
      key: s.key,
      alive: s.alive,
      pid: s.proc?.pid ?? null,
      command: s.command,
      title: s.title,
    }))
  }

  /**
   * Task-archive sweep: kill every session whose task id (the segment of
   * the key before the first `::` — see the TUI's `tabPtyKey`) is no
   * longer a live task. Keeps a headless `kobe api task-archive` from
   * leaking an engine that runs forever with no owner.
   */
  sweepTasks(liveTaskIds: ReadonlySet<string>): void {
    for (const key of Array.from(this.sessions.keys())) {
      const taskId = key.split("::")[0] ?? key
      if (!liveTaskIds.has(taskId)) this.kill(key)
    }
  }

  /** Kill every session — daemon shutdown owns its children's lifetime. */
  killAll(): void {
    for (const key of Array.from(this.sessions.keys())) this.kill(key)
  }

  /** Sessions whose child is still running — the host process's reason
   *  to stay alive (`pty-server.ts` idle-exits at zero, like tmux). */
  liveCount(): number {
    let n = 0
    for (const session of this.sessions.values()) if (session.alive) n++
    return n
  }

  private spawn(key: string, spec: PtySpawnSpec): PtySessionState {
    const argv =
      spec.command && spec.command.length > 0 ? [...spec.command] : [spec.shell ?? process.env.SHELL ?? "/bin/bash"]
    const session: PtySessionState = {
      key,
      proc: null,
      alive: true,
      chunks: [],
      bytes: 0,
      cols: spec.cols,
      rows: spec.rows,
      command: argv,
      title: "",
      titleCarry: "",
      titleDecoder: new StringDecoder("utf8"),
      sinks: new Map(),
    }
    try {
      session.proc = Bun.spawn(argv, {
        cwd: spec.cwd,
        env: embeddedTerminalEnv(process.env, {
          TERM: "xterm-256color",
          COLUMNS: String(spec.cols),
          LINES: String(spec.rows),
          BASH_SILENCE_DEPRECATION_WARNING: "1",
          KOBE_TERMINAL_PTY: "1",
        }),
        terminal: {
          cols: spec.cols,
          rows: spec.rows,
          name: "xterm-256color",
          data: (_terminal, data) => this.onData(session, data),
          exit: () => this.markExited(session),
        },
      })
      void session.proc.exited.then(
        () => this.markExited(session),
        () => this.markExited(session),
      )
      this.opts.log?.("pty", `spawned ${argv[0]} for ${key} (pid ${session.proc.pid})`)
      this.opts.onSessionStart?.()
    } catch (err) {
      session.alive = false
      this.opts.log?.("pty", `spawn failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return session
  }

  /**
   * Keep the LAST complete OSC 0/2 title per session — the one VT fact the
   * host tracks (a plain string scan, not escape-code emulation), so
   * `pty.list` can report each child's live process name without a TUI
   * attached. An unterminated tail is carried into the next chunk (capped).
   */
  private scanTitle(session: PtySessionState, buf: Buffer): void {
    const text = session.titleCarry + session.titleDecoder.write(buf)
    let last: string | null = null
    let end = 0
    OSC_TITLE_RE.lastIndex = 0
    for (let m = OSC_TITLE_RE.exec(text); m; m = OSC_TITLE_RE.exec(text)) {
      last = m[1] ?? ""
      end = m.index + m[0].length
    }
    if (last !== null) session.title = last
    const rest = text.slice(end)
    const esc = rest.lastIndexOf("\x1b")
    session.titleCarry = esc === -1 ? "" : rest.slice(esc, esc + TITLE_CARRY_CAP)
  }

  private onData(session: PtySessionState, data: string | Uint8Array): void {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
    this.scanTitle(session, buf)
    session.chunks.push(buf)
    session.bytes += buf.byteLength
    // ponytail: O(chunks) front-trim like the web sidecar; a chunk may
    // overshoot the cap slightly — replay correctness only needs "recent
    // tail", the client's xterm re-derives the screen from whatever it gets.
    while (session.bytes > (this.opts.scrollbackCap ?? DEFAULT_SCROLLBACK_CAP) && session.chunks.length > 1) {
      const dropped = session.chunks.shift()
      if (dropped) session.bytes -= dropped.byteLength
    }
    if (session.sinks.size === 0) return
    const frame: DaemonFrame = {
      type: "event",
      name: "pty.data",
      payload: { key: session.key, data: buf.toString("base64") },
    }
    for (const sink of session.sinks.values()) sink(frame)
  }

  private markExited(session: PtySessionState): void {
    if (!session.alive) return
    session.alive = false
    const frame: DaemonFrame = {
      type: "event",
      name: "pty.exit",
      payload: { key: session.key, pid: session.proc?.pid ?? null },
    }
    for (const sink of session.sinks.values()) sink(frame)
    this.opts.log?.("pty", `session ${session.key} exited`)
    this.opts.onSessionEnd?.()
  }

  private endChild(session: PtySessionState): void {
    const wasAlive = session.alive
    this.markExited(session)
    if (!wasAlive) return
    try {
      session.proc?.terminal?.close()
    } catch {
      /* best effort */
    }
    try {
      session.proc?.kill("SIGTERM")
    } catch {
      /* best effort */
    }
  }
}
