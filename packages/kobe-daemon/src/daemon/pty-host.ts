/**
 * PtyHost — daemon-hosted PTY sessions (protocol v4).
 *
 * The tmux-persistence replacement for the embedded terminal: the daemon
 * owns the raw PTY child (spawned through a `PtyDriver`) plus a capped
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
 * by an explicit `kill` or the task-archive sweep (`sweepTasks`).
 *
 * Freeze/restore (`pty-freeze-store.ts`): every session's metadata and
 * ring persist to disk (throttled while streaming, immediately on exit,
 * fully at shutdown), so the host PROCESS ending — idle-exit, crash, a
 * machine reboot — no longer takes the work scene with it. The next host
 * thaws each session as a dead "restored" corpse with its scrollback, and
 * the first `open` respawns the child in place using the caller's launch
 * spec (the TUI's dead-reattach passes its engine `--resume` argv). Only
 * an explicit `kill`, the archive sweep, or `rove reset` (which wipes the
 * store) forgets a session for good.
 */

import { resolveLoginShell } from "./platform-shell.js"
import type { PtyPeekResult } from "./protocol.ts"
import { applyResize, fanOut, resizeFrame, writeInput } from "./pty-arbitration.ts"
import { type PtyExit, bunTerminalDriver } from "./pty-driver.ts"
import { embeddedTerminalEnv } from "./pty-env.js"
import { type FrozenPtySession, freezeSession, thawSession } from "./pty-freeze-store.ts"
import {
  type PtyAttachResult,
  type PtyHostOptions,
  type PtySessionState,
  type PtySink,
  type PtySpawnSpec,
  freshSessionState,
} from "./pty-host-types.ts"
import {
  type PtyHostStats,
  type PtySessionInfo,
  describeExit,
  hostStats,
  peekRing,
  ringTail,
  scanOscTitle,
  sessionInfo,
} from "./pty-observability.ts"
import { terminatePtyChild } from "./pty-termination.ts"
import { WarmSpare } from "./pty-warm.ts"

export type { PtyHostStats, PtySessionInfo } from "./pty-observability.ts"
// Re-exported for the cross-chunk title-boundary tests (pure fold).
export { foldOscTitle } from "./pty-observability.ts"
export type { PtyAttachResult, PtyHostOptions, PtySessionState, PtySink, PtySpawnSpec } from "./pty-host-types.ts"

/** Per-session scrollback cap — same order as the web PTY sidecar's 256KB. */
export const DEFAULT_SCROLLBACK_CAP = 512 * 1024
/** Raw ring tail captured into a session's death record. */
const EXIT_TAIL_BYTES = 16 * 1024

/** Minimum gap between a session's periodic freeze writes (crash-loss bound).
 *  Exits and shutdowns flush immediately; this only throttles the live stream. */
export const FREEZE_INTERVAL_MS = 5_000

export class PtyHost {
  private readonly sessions = new Map<string, PtySessionState>()
  private readonly opts: PtyHostOptions
  private parkRestoreDeltas = 0
  private parkRestoreFallbacks = 0
  /** The one warm-spare shell slot (see `pty-warm.ts`). */
  private readonly warmSpare = new WarmSpare({
    spawn: (key, spec, spare) => this.spawn(key, spec, spare),
    endChild: (session) => this.endChild(session),
    markExited: (session) => this.markExited(session),
    log: (event, message) => this.opts.log?.(event, message),
    onSessionStart: () => this.opts.onSessionStart?.(),
  })

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
    let respawned = false
    if (!session) {
      created = true
      session = this.warmSpare.adopt(key, spec) ?? this.spawn(key, spec)
      this.sessions.set(key, session)
    } else if (!session.alive && session.restored) {
      // A freeze-restored corpse is a host-death casualty, not a death the
      // user saw: respawn it in place (scrollback kept) instead of handing
      // back a post-mortem. The caller's spec wins when it carries a
      // command — the TUI's dead-reattach passes its engine-resume launch.
      this.respawn(session, spec)
      respawned = session.alive
    } else if (
      session.alive &&
      spec.cols !== undefined &&
      spec.rows !== undefined &&
      (session.cols !== spec.cols || session.rows !== spec.rows)
    ) {
      // Reattach from a differently-sized client: last-attach-wins, like
      // tmux — the SIGWINCH makes a full-screen app repaint at the new
      // size, fixing what the stale-size replay painted. Size-less opens
      // (headless delivery/ensure clients) never resize: shrinking a live
      // session out from under its attached TUI garbles the pane (#18).
      this.resize(key, spec.cols, spec.rows, token)
    }
    session.sinks.set(token, sink)
    // Only a client that actually CONSUMES the parked screen ends the park.
    // A size-less headless open (`rove api send`'s delivery attach) that
    // detaches a moment later must not wipe another client's park
    // bookkeeping — `rove doctor`'s parked accounting reads it, and phase 4
    // makes those transient third clients routine.
    if (sinceOffset !== undefined) {
      session.parked = false
      session.parkedScreenBytes = 0
    }
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
      respawned,
      offset: session.totalBytes,
      sinceValid,
    }
  }

  /** Pre-spawn one idle shell for adoption — policy lives in `pty-warm.ts`. */
  warm(cwd: string, shell?: string, cols = 80, rows = 24): void {
    this.warmSpare.warm(cwd, shell, cols, rows)
  }

  /** Forward client input (already UTF-8 text from xterm) to the child.
   *  Every attached client may write — see `pty-arbitration.ts`. */
  write(key: string, data: string): void {
    const session = this.sessions.get(key)
    if (session) writeInput(session, data)
  }

  /** Last-writer-wins resize (`pty-arbitration.ts`): the newest dimensions
   *  set the child's grid whoever sent them, an unchanged request is a
   *  no-op, and a real change is announced to the OTHER attached clients so
   *  their VT emulator can follow. `origin` is the requesting connection,
   *  which is skipped by that broadcast. */
  resize(key: string, cols: number, rows: number, origin?: object): void {
    const session = this.sessions.get(key)
    if (!session || !applyResize(session, cols, rows)) return
    fanOut(session, resizeFrame(session.key, cols, rows), origin)
  }

  /** End the child AND forget the session (explicit close / archive). */
  kill(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) return Promise.resolve()
    this.sessions.delete(key)
    // An explicit close is not a restart casualty — drop the freeze record
    // so the next host incarnation does not resurrect what was closed.
    this.opts.freeze?.drop(key)
    return this.endChild(session)
  }

  /**
   * Re-key a running session (`pty.rename`) — the scratch-fold move (issue
   * #40): the shell keeps running untouched, only its ownership label
   * changes, so the task-archive sweep and every future attach see it under
   * the adopting task. No-ops (false) when the source is missing or the
   * target key is taken — the caller must pick a free tab id first. The
   * old key's freeze record moves with it; attached sinks keep streaming
   * (frames carry `session.key`, which is now the new one).
   */
  rename(from: string, to: string): boolean {
    const session = this.sessions.get(from)
    if (!session || from === to || this.sessions.has(to)) return false
    this.sessions.delete(from)
    session.key = to
    this.sessions.set(to, session)
    this.opts.freeze?.drop(from)
    this.maybeFreeze(session, true)
    this.opts.log?.("pty", `renamed session ${from} → ${to}`)
    return true
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
    return Array.from(this.sessions.values(), (s) => sessionInfo(s))
  }

  /** Read-only ring peek (`pty.peek`) — no attach, no spawn, no resize. */
  peek(key: string, sinceOffset?: number): PtyPeekResult {
    return peekRing(this.sessions.get(key), sinceOffset)
  }

  /** Retention facts for diagnostics; no terminal bytes leave the host. */
  stats(): PtyHostStats {
    return hostStats(
      this.sessions.values(),
      this.opts.scrollbackCap ?? DEFAULT_SCROLLBACK_CAP,
      this.parkRestoreDeltas,
      this.parkRestoreFallbacks,
    )
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
    sessions.push(this.warmSpare.end())
    await Promise.all(sessions)
  }

  /**
   * Host-process teardown (the server's close()): freeze every session
   * FIRST so the next host incarnation can restore it, then end the live
   * children. Unlike killAll this never DROPS freeze records — a host
   * restart is exactly what the freeze store exists for. Explicit kills
   * (tab close, archive sweep, `rove reset`'s store wipe) stay gone.
   */
  async shutdown(): Promise<void> {
    this.flushFrozen()
    const endings = Array.from(this.sessions.values(), (session) => this.endChild(session))
    endings.push(this.warmSpare.end())
    await Promise.all(endings)
  }

  /** Persist every session's freeze snapshot now (shutdown path). */
  flushFrozen(): void {
    for (const session of this.sessions.values()) this.maybeFreeze(session, true)
  }

  /**
   * Rebuild sessions from freeze records at host boot — each comes back as
   * a dead "restored" corpse with its ring intact; the first `open`
   * respawns the child in place. Records for keys this host already has
   * (never in practice — restore runs before listen) lose. Returns how
   * many sessions thawed.
   */
  restoreFrozen(records: readonly FrozenPtySession[]): number {
    let restoredCount = 0
    for (const record of records) {
      if (this.sessions.has(record.key)) continue
      const session = thawSession(record, this.opts.scrollbackCap ?? DEFAULT_SCROLLBACK_CAP)
      if (!session) continue
      this.sessions.set(record.key, session)
      restoredCount++
    }
    if (restoredCount > 0) this.opts.log?.("pty", `restored ${restoredCount} frozen session(s) from disk`)
    return restoredCount
  }

  /**
   * Bring a freeze-restored corpse back to life IN PLACE: the old ring
   * stays (the reattaching client replays where the session left off and
   * live output appends after it), the child restarts from the caller's
   * spec when it carries a command, else the frozen one. `restored` clears
   * either way — a failed respawn becomes an ordinary view-only corpse,
   * not a restore candidate retried on every attach.
   */
  private respawn(session: PtySessionState, spec: PtySpawnSpec): void {
    session.restored = false
    session.exit = null
    if (spec.command && spec.command.length > 0) session.command = [...spec.command]
    session.cols = spec.cols ?? session.cols
    session.rows = spec.rows ?? session.rows
    this.startChild(session)
    if (!session.alive) return
    this.opts.log?.("pty", `respawned restored session ${session.key} (pid ${session.proc?.pid})`)
    this.opts.onSessionStart?.()
  }

  /**
   * Throttled freeze writer. The write happens at most once per
   * FREEZE_INTERVAL_MS per session (a host crash loses at most that much
   * scrollback), immediately on exit, and for every session on shutdown.
   * Internal keys (the warm spare) never freeze.
   */
  private maybeFreeze(session: PtySessionState, force = false): void {
    const freeze = this.opts.freeze
    if (!freeze || session.key.startsWith("::")) return
    const now = Date.now()
    if (!force && now - session.lastFreezeAtMs < FREEZE_INTERVAL_MS) return
    session.lastFreezeAtMs = now
    freeze.save(freezeSession(session))
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
    const argv = spec.command && spec.command.length > 0 ? [...spec.command] : [spec.shell ?? resolveLoginShell()]
    const session = freshSessionState(key, spec, argv)
    this.startChild(session)
    if (session.alive) {
      this.opts.log?.("pty", `spawned ${argv[0]} for ${key} (pid ${session.proc?.pid})`)
      if (!spare) this.opts.onSessionStart?.()
    }
    return session
  }

  /**
   * Start `session`'s child process against its current command/cwd/size —
   * the shared tail of a fresh spawn and a restored session's respawn. On
   * failure the session flips to dead (a fresh spawn reports it, a respawn
   * leaves an ordinary view-only corpse).
   */
  private startChild(session: PtySessionState): void {
    try {
      session.proc = (this.opts.driver ?? bunTerminalDriver())({
        argv: [...session.command],
        cwd: session.cwd,
        env: embeddedTerminalEnv(process.env, {
          TERM: "xterm-256color",
          COLUMNS: String(session.cols),
          LINES: String(session.rows),
          BASH_SILENCE_DEPRECATION_WARNING: "1",
          KOBE_TERMINAL_PTY: "1",
        }),
        cols: session.cols,
        rows: session.rows,
        onData: (data) => this.onData(session, data),
      })
      session.alive = true
      void session.proc.exited.then(
        (exit) => this.markExited(session, exit),
        () => this.markExited(session),
      )
    } catch (err) {
      session.alive = false
      this.opts.log?.("pty", `spawn failed for ${session.key}: ${err instanceof Error ? err.message : String(err)}`)
    }
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
    if (session.sinks.size > 0) {
      const payload = { key: session.key, data: buf.toString("base64") }
      fanOut(session, { type: "event", name: "pty.data", payload })
    }
    this.maybeFreeze(session)
  }

  private markExited(session: PtySessionState, exit?: PtyExit): void {
    if (!session.alive) return
    session.alive = false
    session.exit = { code: exit?.code ?? null, signal: exit?.signal ?? null, at: new Date().toISOString() }
    try {
      session.proc?.close()
    } catch {
      /* already closed */
    }
    const payload = { key: session.key, pid: session.proc?.pid ?? null, ...session.exit }
    fanOut(session, { type: "event", name: "pty.exit", payload })
    this.opts.log?.("pty", `session ${session.key} exited${describeExit(session.exit)}`)
    // Final freeze: the exit record AND the scrollback as it stood at death
    // must both survive this host's own end (idle-exit, crash).
    this.maybeFreeze(session, true)
    try {
      this.opts.onSessionExit?.({
        key: session.key,
        pid: session.proc?.pid ?? null,
        exit: session.exit,
        tail: ringTail(session.chunks, session.bytes, EXIT_TAIL_BYTES),
      })
    } catch {
      // A death-record hook must never block session teardown.
    }
    this.opts.onSessionEnd?.()
  }

  private async endChild(session: PtySessionState): Promise<void> {
    if (!session.alive) return
    const proc = session.proc
    if (!proc) {
      this.markExited(session)
      return
    }
    await terminatePtyChild(proc, () => this.markExited(session))
  }
}
