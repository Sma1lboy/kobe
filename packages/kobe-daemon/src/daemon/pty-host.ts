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
import { type PtyHostStats, type PtySessionInfo, scanOscTitle } from "./pty-observability.ts"

export type { PtyHostStats, PtySessionInfo } from "./pty-observability.ts"
// Re-exported for the cross-chunk title-boundary tests (pure fold).
export { foldOscTitle } from "./pty-observability.ts"

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
  /** True when this open spawned/adopted the session — see `PtyOpenResult.created`. */
  readonly created: boolean
  /** Monotonic byte offset at attach — see `PtyOpenResult.offset`. */
  readonly offset: number
  /** `replay` is the exact delta since the request's `sinceOffset` — see `PtyOpenResult.sinceValid`. */
  readonly sinceValid: boolean
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
/** Let a cooperative terminal child shut down before escalating to SIGKILL. */
const TERMINATION_GRACE_MS = 500

interface PtySessionState {
  /** Mutable: warm-shell adoption re-keys the spare under the opener's key. */
  key: string
  readonly cwd: string
  proc: ReturnType<typeof Bun.spawn> | null
  alive: boolean
  chunks: Buffer[]
  bytes: number
  /** Total bytes the child has EVER written (monotonic — never reduced by
   *  ring trimming). `totalBytes - bytes` is the ring window's start
   *  offset; a detached client's recorded offset stays comparable across
   *  trims, which is what makes `sinceOffset` delta replays exact. */
  totalBytes: number
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
  /** A detached TUI still holds a serialized screen for an exact-delta wake. */
  parked: boolean
  parkedScreenBytes: number
}

export class PtyHost {
  private readonly sessions = new Map<string, PtySessionState>()
  private readonly opts: PtyHostOptions
  private parkRestoreDeltas = 0
  private parkRestoreFallbacks = 0
  /**
   * One pre-initialized spare shell (`pty.warm`) kept OUTSIDE the session
   * map — invisible to `list`/`sweepTasks`/`liveCount` (it must not pin
   * the host open or be swept as an orphan). A matching `open` adopts it
   * under the opener's key and a replacement is warmed right away.
   * ponytail: single global slot keyed by cwd; per-worktree pools if
   * multi-repo warm hits matter.
   */
  private spare: PtySessionState | null = null

  constructor(opts: PtyHostOptions = {}) {
    this.opts = opts
  }

  /**
   * Attach `token`'s connection to the session for `key`, spawning the
   * child on first open (adopting the warm spare when it matches). On
   * reattach the spawn spec is IGNORED (the session already runs); the
   * caller gets the ring-buffer replay either way. A fresh TUI can
   * therefore always pass its would-be spawn command — an existing
   * background session simply wins.
   */
  open(
    key: string,
    spec: PtySpawnSpec,
    token: object,
    sink: PtySink,
    sinceOffset?: number,
    sincePid?: number,
  ): PtyAttachResult {
    let session = this.sessions.get(key)
    let created = false
    if (!session) {
      created = true
      session = this.adoptSpare(key, spec) ?? this.spawn(key, spec)
      this.sessions.set(key, session)
    } else if (session.alive && (session.cols !== spec.cols || session.rows !== spec.rows)) {
      // Reattach from a differently-sized client: last-attach-wins, like
      // tmux — the SIGWINCH makes a full-screen app repaint at the new
      // size, fixing what the stale-size replay painted.
      this.resize(key, spec.cols, spec.rows)
    }
    session.sinks.set(token, sink)
    session.parked = false
    session.parkedScreenBytes = 0
    // Delta replay: a parking client recorded the monotonic offset it had
    // consumed; when that offset is still inside the ring window AND the
    // child is the same incarnation it parked against (`sincePid`), replay
    // ONLY the bytes written since — its serialized screen + this delta is
    // bit-identical to never detaching. The pid check lives HERE because
    // the client can't validate before the slice: a stale restore must get
    // the full ring, not a delta it will discard. Trimmed-away offsets and
    // respawned keys fall back the same way.
    const windowStart = session.totalBytes - session.bytes
    let replay = Buffer.concat(session.chunks)
    let sinceValid = false
    if (
      !created &&
      sinceOffset !== undefined &&
      sinceOffset >= windowStart &&
      sinceOffset <= session.totalBytes &&
      sincePid !== undefined &&
      sincePid === session.proc?.pid
    ) {
      replay = replay.subarray(sinceOffset - windowStart)
      sinceValid = true
    }
    if (sinceOffset !== undefined && sincePid !== undefined) {
      if (sinceValid) this.parkRestoreDeltas++
      else this.parkRestoreFallbacks++
    }
    return {
      replay: replay.toString("base64"),
      alive: session.alive,
      pid: session.proc?.pid ?? null,
      created,
      offset: session.totalBytes,
      sinceValid,
    }
  }

  /** The bare-shell argv a spec resolves to when it has no command. */
  private static shellArgv(shell: string | undefined): string {
    return shell ?? process.env.SHELL ?? "/bin/bash"
  }

  /**
   * Keep one idle shell pre-spawned for `cwd`. A live spare for the same
   * cwd+shell is kept; anything else is replaced (single slot — the most
   * recently warmed worktree wins). The spare deliberately skips
   * `onSessionStart` so it never cancels the host's idle-exit.
   */
  warm(cwd: string, shell?: string, cols = 80, rows = 24): void {
    const argv0 = PtyHost.shellArgv(shell)
    if (this.spare?.alive && this.spare.cwd === cwd && this.spare.command[0] === argv0) return
    const old = this.spare
    this.spare = null
    if (old) this.endChild(old)
    const session = this.spawn("::spare", { cwd, command: [argv0], cols, rows }, true)
    this.spare = session.alive ? session : null
  }

  /**
   * Hand the spare over to `open(key)` when it matches the spec: same
   * cwd, and the spec resolves to the spare's bare shell. The adopted
   * session becomes a REAL one (it now pins the host open) and a
   * replacement spare is warmed immediately.
   */
  private adoptSpare(key: string, spec: PtySpawnSpec): PtySessionState | null {
    const spare = this.spare
    if (!spare?.alive || spare.cwd !== spec.cwd) return null
    const want = spec.command && spec.command.length > 0 ? spec.command : [PtyHost.shellArgv(spec.shell)]
    if (want.length !== 1 || want[0] !== spare.command[0]) return null
    this.spare = null
    spare.key = key
    if (spare.cols !== spec.cols || spare.rows !== spec.rows) {
      spare.cols = spec.cols
      spare.rows = spec.rows
      try {
        spare.proc?.terminal?.resize(spec.cols, spec.rows)
      } catch {
        this.markExited(spare)
        return null
      }
    }
    this.opts.log?.("pty", `adopted warm shell for ${key} (pid ${spare.proc?.pid})`)
    this.opts.onSessionStart?.()
    this.warm(spec.cwd, spare.command[0], spec.cols, spec.rows)
    return spare
  }

  /** Forward client input (already UTF-8 text from xterm) to the child. */
  write(key: string, data: string): void {
    const session = this.sessions.get(key)
    if (!session?.alive || data.length === 0) return
    try {
      session.proc?.terminal?.write(data)
    } catch {
      // A terminal stream error is not proof the subprocess exited. Bun's
      // `proc.exited` promise below is the single source of truth.
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
      // See write(): wait for `proc.exited`, not the PTY stream state.
    }
  }

  /** End the child AND forget the session (explicit close / archive). */
  kill(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) return Promise.resolve()
    this.sessions.delete(key)
    return this.endChild(session)
  }

  /** Detach one connection from one session; the child keeps running. */
  detach(key: string, token: object, parked = false, parkedScreenBytes = 0): void {
    const session = this.sessions.get(key)
    if (!session) return
    session.sinks.delete(token)
    // One socket has one sink per key. Only the final detach describes the
    // session's current visibility; a second attached client is still live.
    if (session.sinks.size === 0) {
      session.parked = parked
      session.parkedScreenBytes = parked ? Math.max(0, parkedScreenBytes) : 0
    }
  }

  /** Detach one connection from EVERY session (socket closed). */
  detachClient(token: object): void {
    for (const session of this.sessions.values()) {
      session.sinks.delete(token)
      // A socket vanished without an explicit park detach, so no local
      // registry is guaranteed to retain a restorable screen.
      if (session.sinks.size === 0) {
        session.parked = false
        session.parkedScreenBytes = 0
      }
    }
  }

  /** Session inventory — lets a fresh TUI discover background sessions. */
  list(): PtySessionInfo[] {
    return Array.from(this.sessions.values(), (s) => ({
      key: s.key,
      alive: s.alive,
      pid: s.proc?.pid ?? null,
      command: s.command,
      title: s.title,
      parked: s.parked,
      parkedScreenBytes: s.parkedScreenBytes,
    }))
  }

  /** Retention facts for diagnostics; no terminal bytes leave the host. */
  stats(): PtyHostStats {
    let ringBytes = 0
    let parkedSessions = 0
    let parkedScreenBytes = 0
    for (const session of this.sessions.values()) {
      ringBytes += session.bytes
      if (session.parked) {
        parkedSessions++
        parkedScreenBytes += session.parkedScreenBytes
      }
    }
    return {
      ringBytes,
      ringCapacityBytes: this.sessions.size * (this.opts.scrollbackCap ?? DEFAULT_SCROLLBACK_CAP),
      parkedSessions,
      parkedScreenBytes,
      parkRestoreDeltas: this.parkRestoreDeltas,
      parkRestoreFallbacks: this.parkRestoreFallbacks,
    }
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

  /** Kill every session and the warm spare before host shutdown completes. */
  async killAll(): Promise<void> {
    const sessions = Array.from(this.sessions.keys(), (key) => this.kill(key))
    const spare = this.spare
    this.spare = null
    if (spare) sessions.push(this.endChild(spare))
    await Promise.all(sessions)
  }

  /** Sessions whose child is still running — the host process's reason
   *  to stay alive (`pty-server.ts` idle-exits at zero, like tmux). */
  liveCount(): number {
    let n = 0
    for (const session of this.sessions.values()) if (session.alive) n++
    return n
  }

  /** `spare` skips `onSessionStart` — a warm shell must not pin the host
   *  open (its adoption fires the callback instead). */
  private spawn(key: string, spec: PtySpawnSpec, spare = false): PtySessionState {
    const argv = spec.command && spec.command.length > 0 ? [...spec.command] : [PtyHost.shellArgv(spec.shell)]
    const session: PtySessionState = {
      key,
      cwd: spec.cwd,
      proc: null,
      alive: true,
      chunks: [],
      bytes: 0,
      totalBytes: 0,
      cols: spec.cols,
      rows: spec.rows,
      command: argv,
      title: "",
      titleCarry: "",
      titleDecoder: new StringDecoder("utf8"),
      sinks: new Map(),
      parked: false,
      parkedScreenBytes: 0,
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
        },
      })
      void session.proc.exited.then(
        () => this.markExited(session),
        () => this.markExited(session),
      )
      this.opts.log?.("pty", `spawned ${argv[0]} for ${key} (pid ${session.proc.pid})`)
      if (!spare) this.opts.onSessionStart?.()
    } catch (err) {
      session.alive = false
      this.opts.log?.("pty", `spawn failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return session
  }

  private onData(session: PtySessionState, data: string | Uint8Array): void {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
    scanOscTitle(session, buf)
    session.chunks.push(buf)
    session.bytes += buf.byteLength
    session.totalBytes += buf.byteLength
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
    try {
      session.proc?.terminal?.close()
    } catch {
      /* already closed */
    }
    const frame: DaemonFrame = {
      type: "event",
      name: "pty.exit",
      payload: { key: session.key, pid: session.proc?.pid ?? null },
    }
    for (const sink of session.sinks.values()) sink(frame)
    this.opts.log?.("pty", `session ${session.key} exited`)
    this.opts.onSessionEnd?.()
  }

  private async endChild(session: PtySessionState): Promise<void> {
    if (!session.alive) return
    const proc = session.proc
    if (!proc) {
      this.markExited(session)
      return
    }
    this.signalProcessGroup(proc.pid, "SIGTERM", () => proc.kill("SIGTERM"))
    let timer: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), TERMINATION_GRACE_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (!exited) this.signalProcessGroup(proc.pid, "SIGKILL", () => proc.kill("SIGKILL"))
    try {
      await proc.exited
    } catch {
      /* process exit remains the lifecycle boundary even on a runtime error */
    }
    this.markExited(session)
  }

  private signalProcessGroup(pid: number, signal: NodeJS.Signals, fallback: () => void): void {
    if (process.platform !== "win32" && pid > 1) {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Some runtimes do not make the PTY child its own group leader.
      }
    }
    try {
      fallback()
    } catch {
      /* already gone */
    }
  }
}
