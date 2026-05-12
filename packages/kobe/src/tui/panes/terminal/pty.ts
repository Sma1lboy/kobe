/**
 * Terminal pane PTY abstraction (Stream J).
 *
 * `TaskPty` is the unit kobe's terminal pane consumes. One instance ==
 * one shell scoped to one task's worktree. The implementation is
 * swappable via the `BACKEND` strategy below; today we ship a tmux
 * backend by default plus a mock backend for tests.
 *
 * # Why tmux (and not node-pty)
 *
 * Stream 0.4 documented in `test/behavior/driver.ts`: `node-pty`'s
 * `onData` callback does NOT fire under Bun 1.3.x. We re-verified that
 * during the J spike — `pty.spawn()` succeeds (no error), but data
 * never streams back. Stream 0.4 worked around it by spawning kobe
 * (under bun) as a subprocess of vitest (under node), so node-pty ran
 * under node. The terminal pane runs INSIDE kobe (under bun), so that
 * trick is unavailable to us.
 *
 * Three backends were considered:
 *
 *   1. node-pty inside bun                  — broken (data never emits)
 *   2. Bun.spawn with stdio:pipe            — works, but not a real PTY.
 *      Many CLIs (interactive `claude`, `vim`, `htop`) detect non-TTY
 *      stdout via `isatty()` and degrade or refuse. The terminal pane
 *      is supposed to run *anything* the user types — pretending to
 *      be a tty for half the world's commands is a stable footgun.
 *   3. tmux                                 — proven (agent-deck uses
 *      it: see `refs/agent-deck/internal/tmux/`). Real PTY semantics,
 *      session persists across kobe restarts, naturally maps "one pty
 *      per task" → "one session per task", trivial capture protocol
 *      (`tmux capture-pane -p`).
 *
 * tmux wins. Cost: a tmux binary on the host. We surface the dependency
 * in the README; on macOS most developers already have it from `brew
 * install tmux`.
 *
 * # Backend swap mechanism
 *
 * `TaskPty` is a class with concrete shape. A second concrete class
 * (`MockTaskPty`) implements the same surface for tests. To swap real
 * backends without rewriting `Terminal.tsx`, set
 * `process.env.KOBE_TERMINAL_BACKEND=mock` (used only by tests; not a
 * supported user toggle) before constructing the registry; production
 * always gets tmux. If we ever need a `Bun.spawn` fallback for hosts
 * without tmux, add a third class implementing the same interface and
 * branch in `createTaskPty`.
 *
 * # Lifecycle
 *
 * Construct → `start()` is implicit (the constructor spawns). The
 * caller drives `write()` for keystrokes, registers an `onData()` listener
 * for output (called with newly-arrived chunks), polls `capture()` for
 * the visible scrollback, and calls `kill()` when the task is archived.
 * `resize(cols, rows)` is forwarded to tmux as a window resize.
 *
 * # `onData` semantics
 *
 * tmux doesn't push data — we have to poll `capture-pane`. To keep the
 * abstraction looking pushy (so a future `Bun.spawn` backend can drop
 * in without changing the consumer), we run a poll loop at
 * `POLL_INTERVAL_MS` and emit a chunk whenever the pane content
 * changes. Listeners receive *full* pane snapshots, not deltas; that
 * matches what tmux gives us and is plenty for plain-text scrollback.
 * The `Terminal.tsx` consumer treats the latest snapshot as the
 * scrollback view.
 *
 * Edge cases handled:
 *   - tmux not installed: constructor throws synchronously with a
 *     human-readable error.
 *   - session name collision: we use the task id, but allow callers
 *     to override (the registry passes the task id as session name).
 *     If a session with that name already exists, we attach to it
 *     rather than fail — matches the "kept alive while in_progress"
 *     spec; if the user re-mounts the pane while the task is still
 *     active, they get the live session back.
 *   - kill() races: idempotent; subsequent calls are no-ops.
 */

import { spawn, spawnSync } from "node:child_process"

/* --------------------------------------------------------------------- */
/*  Public surface                                                        */
/* --------------------------------------------------------------------- */

export type TaskPtyOpts = {
  /** Working directory the shell should start in. Required. */
  cwd: string
  /** Stable id used to name the underlying tmux session. Required. */
  taskId: string
  /** Initial pane size. Default 80x24. */
  cols?: number
  /** Initial pane size. Default 80x24. */
  rows?: number
  /** Override `$SHELL`. Defaults to `process.env.SHELL` or `/bin/bash`. */
  shell?: string
  /** Override the tmux binary. Defaults to `tmux` on PATH. */
  tmuxBin?: string
  /** Polling interval for new output. Default 80 ms. Tests can speed this up. */
  pollIntervalMs?: number
}

/** Listener for new pane snapshots. Receives the full visible pane plus the
 * cursor position captured *atomically* with the snapshot — both come from a
 * single tmux command roundtrip so they describe the exact same grid state. */
export type DataListener = (snapshot: string, cursor: CursorPos | null) => void

/** Cursor position within the visible pane, 0-based. */
export type CursorPos = { x: number; y: number }

/**
 * Common surface every backend implements. The Solid component
 * `Terminal.tsx` only ever sees this shape, so the backend can be
 * swapped without touching the renderer.
 */
export interface TaskPtyLike {
  /** Stable id passed in at construction. Useful for the registry's keying. */
  readonly taskId: string
  /** Working directory the shell was spawned in. */
  readonly cwd: string
  /** Has `kill()` been called or has the underlying process exited? */
  readonly killed: boolean
  /**
   * If the backend exposes the shell as an attachable external session
   * (tmux), this is the session name a separately-spawned terminal can
   * pass to `tmux attach -t <name>`. Undefined for backends without a
   * shareable handle (mocks, in-process PTYs). The terminal pane uses
   * this to "pop out" the live shell into a real terminal window when
   * the user wants native-emulator typing latency.
   */
  readonly externalAttachTarget?: string

  /** Forward keystrokes to the shell. */
  write(data: string): void

  /** Subscribe to new pane snapshots. Returns an unsubscribe function. */
  onData(cb: DataListener): () => void

  /** Resize the underlying pty / tmux window. */
  resize(cols: number, rows: number): void

  /** Capture the current visible scrollback as plain text. */
  capture(): string

  /**
   * Capture the visible-pane cursor position, 0-based. Returns null
   * when the backend can't report (mocks default to null; consumers
   * just don't render a cursor in that case).
   */
  captureCursor(): CursorPos | null

  /** Tear the shell down. Idempotent. */
  kill(): void
}

/* --------------------------------------------------------------------- */
/*  Tmux backend                                                          */
/* --------------------------------------------------------------------- */

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
/**
 * Heartbeat poll interval. Used purely as a fallback when the
 * control-mode subscription isn't delivering events (old tmux, killed
 * client). Under normal operation, `%output` events drive captures via
 * `TmuxControlClient` — this heartbeat is just safety. 1.5 s is enough
 * to notice a dead control client without burning CPU on idle
 * subprocess spawns.
 */
const DEFAULT_POLL_MS = 1500
/**
 * Settle window after the last `%output` event. Kept short so typing
 * feels live: every keystroke turns into a `%output` from the shell's
 * echo, and waiting too long here is exactly the "I type 'a' and
 * nothing happens for 50 ms" symptom. fancy prompts (p10k, starship)
 * still repaint in multiple passes, but their per-pass writes land
 * within 5-10 ms, so a 16 ms window batches them while staying
 * imperceptible to typing.
 */
const CAPTURE_DEBOUNCE_MS = 16
/**
 * Maximum delay we'll postpone a capture even if events keep coming.
 * Caps the worst-case latency during streaming output (`tail -f`,
 * `yes`, ANSI-art tools) to one capture per `CAPTURE_MAX_DELAY_MS`
 * window. 120 ms = ~8 captures/sec under flood — plenty for the eye
 * and keeps the CPU cost bounded.
 */
const CAPTURE_MAX_DELAY_MS = 120
const SESSION_NAME_PREFIX = "kobe-task-"

function defaultShell(): string {
  return process.env.SHELL ?? "/bin/bash"
}

function defaultTmuxBin(): string {
  return process.env.KOBE_TMUX_BIN ?? "tmux"
}

/**
 * Synchronously verify that the tmux binary is reachable. Surfaces a
 * human-readable error early instead of letting `spawn` throw a generic
 * ENOENT later. We spawn `tmux -V` and require a 0 exit + a version
 * string in stdout.
 */
function assertTmuxAvailable(tmuxBin: string): void {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(tmuxBin, ["-V"], { encoding: "utf8" })
  } catch (err) {
    throw new Error(
      `kobe terminal pane requires tmux on PATH. Failed to spawn '${tmuxBin}': ${(err as Error).message}.\nInstall tmux (e.g. 'brew install tmux') or set KOBE_TMUX_BIN to its path.`,
    )
  }
  if (result.error) {
    throw new Error(
      `kobe terminal pane requires tmux on PATH. Failed to spawn '${tmuxBin}': ${result.error.message}.\nInstall tmux (e.g. 'brew install tmux') or set KOBE_TMUX_BIN to its path.`,
    )
  }
  if (result.status !== 0) {
    throw new Error(`kobe terminal pane: '${tmuxBin} -V' exited ${result.status}: ${result.stderr || "(no stderr)"}`)
  }
}

/**
 * Build the tmux session name for a given task id. Constrained to the
 * subset tmux accepts (no dots, colons, whitespace). Task ids are ulids
 * which are already alphanumeric, so we just prefix and truncate.
 */
function sessionNameFor(taskId: string): string {
  // tmux disallows ':' and '.' in session names. Replace defensively.
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
  return `${SESSION_NAME_PREFIX}${safe}`
}

/** Run a tmux command synchronously and return stdout. Throws on non-zero exit. */
function tmuxSync(tmuxBin: string, args: string[]): string {
  const result = spawnSync(tmuxBin, args, { encoding: "utf8" })
  if (result.error) {
    throw new Error(`${tmuxBin} ${args.join(" ")}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `${tmuxBin} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout || "(no output)"}`,
    )
  }
  return result.stdout
}

/**
 * Subscribes to a tmux session's control-mode event stream.
 *
 * `tmux -CC attach-session -t <name>` spawns a tmux client that, instead
 * of rendering a TTY, reads commands on stdin and writes notification
 * lines on stdout — including `%output %<pane-id> <data>` whenever a
 * pane produces output. We don't issue any commands; we just listen for
 * `%output` and use it as a "the shell wrote something — go capture
 * the pane now" wake-up signal.
 *
 * Why this exists, vs. just polling capture-pane every 80 ms:
 *   - Polling can land mid-prompt-repaint. fancy prompts (p10k, pure,
 *     starship) write the prompt, jump up a row to draw a powerline
 *     decoration, jump back. If we capture between those jumps,
 *     `cursor_y` reports the in-progress position one row above the
 *     final prompt. The Terminal pane then renders the cursor one row
 *     above the visible `$` chip and content from the two repaint
 *     phases overlaps. We can't make polling avoid that window.
 *   - Control mode is push-based. Combined with a small debounce
 *     window in the caller (TmuxTaskPty), capture-pane only fires
 *     after the shell has stopped writing for ~50 ms — i.e. after
 *     all repaint phases are done. The pane is then in a stable state
 *     and (snapshot, cursor) are consistent.
 *
 * The control client is best-effort: if it dies or never connects
 * (tmux version too old, session deleted externally), TmuxTaskPty
 * still runs its slow heartbeat poll so the pane never goes mute.
 */
class TmuxControlClient {
  private readonly proc: ReturnType<typeof spawn>
  private readonly outputListeners = new Set<() => void>()
  private buffer = ""
  private _killed = false

  constructor(tmuxBin: string, sessionName: string) {
    this.proc = spawn(tmuxBin, ["-CC", "attach-session", "-t", sessionName], {
      // stdin is BOTH how tmux knows we're attached AND our keystroke
      // write channel: `sendKeys` writes `send-keys -t <pane> -H <hex>`
      // lines through it so the typed-char path doesn't fork a tmux
      // client per keystroke.
      stdio: ["pipe", "pipe", "ignore"],
    })
    this.proc.stdout?.setEncoding("utf8")
    this.proc.stdout?.on("data", (chunk: string) => this.onChunk(chunk))
    // Without this listener, an EPIPE on stdin (tmux client died)
    // bubbles up as an unhandled `error` and crashes the host process.
    this.proc.stdin?.on("error", () => this.markDead())
    this.proc.on("error", () => this.markDead())
    this.proc.on("exit", () => this.markDead())
    // Don't keep the host alive solely on this subprocess.
    this.proc.unref?.()
  }

  get killed(): boolean {
    return this._killed
  }

  /**
   * Forward raw bytes to a tmux pane through the already-attached
   * control client's stdin — the fast path for typed characters.
   *
   * The previous implementation forked `tmux send-keys ...` per write,
   * burning ~5-10 ms per keystroke on fork + exec + IPC + wait. Going
   * through the existing stdin pipe drops the cost to a single
   * `Writable.write` (microseconds); tmux processes the command
   * in-server and dispatches it synchronously. Visible difference is
   * "smooth typing / arrow keys" vs "perceptibly laggy."
   *
   * Returns `false` if the client is dead so the caller can fall back
   * to the spawn path rather than silently dropping the keystroke.
   *
   * We do NOT read the command's `%begin`/`%end` response: `send-keys`
   * produces no payload, and `onChunk` already ignores those lines.
   */
  sendKeys(paneTarget: string, bytes: Buffer): boolean {
    if (this._killed) return false
    const stdin = this.proc.stdin
    if (!stdin || stdin.destroyed) return false
    // 256 hex bytes per line keeps each tmux command under 1 KB and
    // well under any practical argv limit. Multi-byte UTF-8 is fine
    // — we emit raw bytes, not characters.
    const CHUNK = 256
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
      const hex: string[] = []
      for (const b of slice) hex.push(b.toString(16).padStart(2, "0"))
      const cmd = `send-keys -t ${paneTarget} -H ${hex.join(" ")}\n`
      try {
        stdin.write(cmd)
      } catch {
        this.markDead()
        return false
      }
    }
    return true
  }

  onOutput(cb: () => void): () => void {
    this.outputListeners.add(cb)
    return () => {
      this.outputListeners.delete(cb)
    }
  }

  private onChunk(chunk: string): void {
    if (this._killed) return
    this.buffer += chunk
    while (true) {
      const nl = this.buffer.indexOf("\n")
      if (nl === -1) break
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      // The only notification we care about is `%output %<pane-id>
      // <hex-or-raw>`. We don't decode the data — its existence is the
      // signal. tmux also emits %begin/%end/%session-changed/%exit
      // etc.; ignore all of those.
      if (line.startsWith("%output ")) {
        for (const cb of this.outputListeners) {
          try {
            cb()
          } catch {
            /* one listener must not break the others */
          }
        }
      }
    }
  }

  kill(): void {
    if (this._killed) return
    this.markDead()
    try {
      this.proc.kill("SIGTERM")
    } catch {
      /* best effort */
    }
  }

  private markDead(): void {
    this._killed = true
    this.outputListeners.clear()
  }
}

/**
 * Concrete tmux-backed PTY. One tmux session per instance, named after
 * the task id. The session is created on construction; `kill()` closes
 * it. Output is observed via a `TmuxControlClient` (push) backed by a
 * slow heartbeat poll (fallback if the control client dies).
 */
export class TmuxTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  /**
   * Exposed as the `tmux attach -t <name>` target so a separately-
   * spawned terminal can attach to the same shell — see
   * `./pop-out.ts`. Mirrors {@link TaskPtyLike.externalAttachTarget}.
   */
  readonly externalAttachTarget: string
  private readonly tmuxBin: string
  private readonly sessionName: string
  private readonly listeners = new Set<DataListener>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Control-mode subscription. Constructed alongside the tmux session
   * in the constructor; killed in `markDead()` so a session teardown
   * doesn't leave a zombie `tmux -CC` client.
   */
  private controlClient: TmuxControlClient | null = null
  private lastSnapshot = ""
  private lastCursor: CursorPos | null = null
  private _killed = false
  private cols: number
  private rows: number
  /**
   * Timestamp of the most recent `write()` call. The `%output` debounce
   * uses this to tell apart two cases:
   *   - "user just typed" → next `%output` is the echo of that keystroke,
   *     capture immediately so the character shows up with no delay
   *   - "command is producing output" → fancy prompts (p10k, starship)
   *     repaint in multiple passes, so debounce for stability
   * Without this distinction, every keystroke would wait the full
   * debounce window, surfacing as typing lag.
   */
  private justWroteAt = 0
  /**
   * Serialized write queue. Each write spawns a tmux process; if we
   * fired them concurrently they could land out of order in the pty
   * (we proved that empirically during the J spike). The queue
   * ensures ordering by waiting for each spawn to close before
   * launching the next.
   */
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(opts: TaskPtyOpts) {
    this.taskId = opts.taskId
    this.cwd = opts.cwd
    this.cols = opts.cols ?? DEFAULT_COLS
    this.rows = opts.rows ?? DEFAULT_ROWS
    this.tmuxBin = opts.tmuxBin ?? defaultTmuxBin()
    this.sessionName = sessionNameFor(opts.taskId)
    this.externalAttachTarget = this.sessionName

    assertTmuxAvailable(this.tmuxBin)

    const shell = opts.shell ?? defaultShell()

    // If a session with this name already exists (e.g. kobe restarted
    // and the task was still in_progress), attach to it instead of
    // failing. tmux's `has-session` exits 0 when present, 1 when absent.
    const has = spawnSync(this.tmuxBin, ["has-session", "-t", this.sessionName], { encoding: "utf8" })
    let existed = has.status === 0
    if (existed) {
      // Older kobe (before the window-size=manual fix) created sessions
      // in tmux's default `latest` mode, so the pane was sized to the
      // host terminal, not our `<Terminal />` body. Even after we now
      // switch the option and resize, the shell's prompt was rendered
      // against the OLD grid — `cursor_y` then reports against a grid
      // shape that doesn't match what `capture-pane` returns under the
      // new size. Symptom: cursor block lands one row above the live
      // prompt and stays there. Detect "session pre-dates the fix" by
      // checking whether tmux is still reporting a pane far larger than
      // we ever asked for, and start clean if so.
      try {
        const probe = tmuxSync(this.tmuxBin, [
          "display-message",
          "-p",
          "-t",
          this.sessionName,
          "-F",
          "#{pane_height}x#{pane_width}",
        ]).trim()
        const [hStr] = probe.split("x")
        const liveH = Number.parseInt(hStr ?? "0", 10)
        // If the pane is more than 1.5× our requested rows, it was
        // sized for some other client and a clean restart is cheaper
        // (and more correct) than trying to re-flow stale state.
        if (Number.isFinite(liveH) && liveH > this.rows * 1.5) {
          tmuxSync(this.tmuxBin, ["kill-session", "-t", this.sessionName])
          existed = false
        }
      } catch {
        /* probe failed — treat as needing recreation */
        existed = false
      }
    }
    if (!existed) {
      // Set the option BEFORE creating the session so tmux uses our
      // requested -x/-y from the very first render. Setting `manual`
      // requires either a target session OR `-g` for global; since
      // there's no session yet, go global. The option sticks per-server
      // but only applies to sessions; harmless for any other tmux usage
      // outside kobe.
      try {
        tmuxSync(this.tmuxBin, ["set-option", "-g", "window-size", "manual"])
      } catch {
        /* older tmux without this option — fall through. */
      }
      tmuxSync(this.tmuxBin, [
        "new-session",
        "-d",
        "-s",
        this.sessionName,
        "-x",
        String(this.cols),
        "-y",
        String(this.rows),
        "-c",
        opts.cwd,
        shell,
      ])
    }
    // Belt-and-suspenders: also pin per-session window-size so this
    // session survives later changes to the global option, then push
    // the geometry one more time.
    try {
      tmuxSync(this.tmuxBin, ["set-option", "-t", this.sessionName, "window-size", "manual"])
    } catch {
      /* best effort */
    }
    this.resize(this.cols, this.rows)

    // Control-mode push subscription — wakes us when tmux processes
    // new pane output. Each `%output` notification kicks the debounce
    // timer; once we've gone `CAPTURE_DEBOUNCE_MS` with no further
    // events, we capture. fancy prompts that repaint in multiple
    // passes (p10k, starship) batch into one capture this way, so the
    // (snapshot, cursor) pair we render is always a stable end-state.
    this.controlClient = new TmuxControlClient(this.tmuxBin, this.sessionName)
    const debounceMs = CAPTURE_DEBOUNCE_MS
    const maxDelayMs = CAPTURE_MAX_DELAY_MS
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let firstEventAt = 0
    const captureNow = () => {
      if (this._killed) return
      debounceTimer = null
      firstEventAt = 0
      try {
        const { snapshot, cursor } = this.captureWithCursorRaw()
        const snapChanged = snapshot !== this.lastSnapshot
        const cursorChanged =
          (cursor?.x ?? null) !== (this.lastCursor?.x ?? null) || (cursor?.y ?? null) !== (this.lastCursor?.y ?? null)
        this.lastSnapshot = snapshot
        this.lastCursor = cursor
        if (snapChanged || cursorChanged) {
          for (const cb of this.listeners) {
            try {
              cb(snapshot, cursor)
            } catch {
              /* one listener must not break the others */
            }
          }
        }
      } catch {
        this.markDead()
      }
    }
    const scheduleCapture = () => {
      if (this._killed) return
      const now = Date.now()
      if (firstEventAt === 0) firstEventAt = now
      const elapsed = now - firstEventAt
      // Typing echo bypass: if the user just pressed a key, the
      // `%output` we're handling is almost certainly the shell
      // echoing that character. Render immediately so typing feels
      // live. The 50 ms window is well above any plausible round-trip
      // (write → tmux → shell → tmux → %output) but well below the
      // delay needed for fancy-prompt repaint batches to settle, so
      // we keep both behaviours.
      const isEcho = now - this.justWroteAt < 50
      const wait = isEcho ? 0 : Math.min(debounceMs, Math.max(0, maxDelayMs - elapsed))
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(captureNow, wait)
    }
    this.controlClient.onOutput(scheduleCapture)

    // Fallback heartbeat — runs slow on purpose. If the control
    // client dies (host's tmux version too old to honor -CC, manual
    // session kill, etc.) the heartbeat ensures the pane keeps
    // updating. When events are flowing through control mode, the
    // heartbeat tick is a no-op (snapshot/cursor unchanged → no fire).
    const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
    this.pollTimer = setInterval(() => {
      if (this._killed) return
      captureNow()
    }, pollMs)
    this.pollTimer.unref?.()

    // Prime the listener pipe immediately so `Terminal.tsx` doesn't
    // render an empty body for the first tick. The control client
    // won't fire `%output` until the shell prints something; without
    // this initial capture, an idle freshly-spawned shell shows a
    // blank pane until the first keystroke.
    captureNow()
  }

  get killed(): boolean {
    return this._killed
  }

  /**
   * Forward raw keystrokes to the tmux pane.
   *
   * tmux's `send-keys -H` mode takes hex bytes and forwards them
   * verbatim into the pty. That's the cleanest fit for our contract:
   * the consumer hands us a JS string of bytes (possibly including CR
   * 0x0d, ESC 0x1b, ETX 0x03 etc.) and tmux delivers them unchanged.
   *
   * Earlier we tried `load-buffer` + `paste-buffer`, but that path
   * has two problems for keystroke streaming: (a) it's race-prone
   * because the paste fires from the load's `close` event which runs
   * out-of-order vs. follow-up writes, and (b) `paste-buffer` doesn't
   * preserve `\r` semantics — it normalizes line endings depending on
   * the pane's mode.
   *
   * We chunk the input into argv-friendly pieces — argv has a sane
   * length limit but a single `echo` rarely exceeds 1KB. We put a
   * 1024-byte cap per spawn for safety.
   */
  write(data: string): void {
    if (this._killed) return
    if (data.length === 0) return

    // Note "user typed something" so the next `%output` (the echo)
    // bypasses the debounce window — see scheduleCapture in the
    // constructor.
    this.justWroteAt = Date.now()

    // Snapshot the data NOW so the closure below doesn't see a
    // mutated value across queue ticks.
    const bytes = Buffer.from(data, "utf8")

    // Fast path: write through the control client's stdin pipe (no
    // fork). tmux's command pipeline is strictly FIFO so order is
    // preserved across back-to-back keystrokes without us paying ~10 ms
    // per keystroke on fork+IPC. This is the difference between
    // "smooth typing" and "perceptibly laggy."
    if (this.controlClient && !this.controlClient.killed) {
      if (this.controlClient.sendKeys(this.sessionName, bytes)) return
    }

    // Fallback: serialized spawn queue. Kicks in when the control
    // client is dead (old tmux, manually killed) or never came up.
    // Same ordering guarantees: each chunk awaits the prior spawn.
    this.writeQueue = this.writeQueue.then(() => this.sendBytesSerialized(bytes))
    this.writeQueue = this.writeQueue.catch(() => {})
  }

  /**
   * Internal: send `bytes` to tmux in argv-friendly chunks, awaiting
   * each spawn so order is preserved. Used by the write queue.
   */
  private async sendBytesSerialized(bytes: Buffer): Promise<void> {
    if (this._killed) return
    const CHUNK = 256 // bytes per spawn (argv room is ~64KB but stay generous)
    for (let i = 0; i < bytes.length; i += CHUNK) {
      if (this._killed) return
      const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
      const hexArgs: string[] = []
      for (const b of slice) hexArgs.push(b.toString(16).padStart(2, "0"))
      await new Promise<void>((resolve) => {
        const proc = spawn(this.tmuxBin, ["send-keys", "-t", this.sessionName, "-H", ...hexArgs], {
          stdio: ["ignore", "ignore", "ignore"],
        })
        proc.on("error", () => resolve())
        proc.on("close", () => resolve())
      })
    }
  }

  onData(cb: DataListener): () => void {
    this.listeners.add(cb)
    // Fire once immediately so a freshly-mounted listener sees the
    // current pane content without waiting for a poll tick.
    if (this.lastSnapshot !== "") {
      try {
        cb(this.lastSnapshot, this.lastCursor)
      } catch {
        /* swallow */
      }
    }
    return () => {
      this.listeners.delete(cb)
    }
  }

  resize(cols: number, rows: number): void {
    if (this._killed) return
    this.cols = cols
    this.rows = rows
    try {
      // refresh-client -C resizes the client viewport for the session.
      // Combined with `resize-window -t <session> -x cols -y rows` to
      // also resize the underlying window so capture-pane returns the
      // expected dimensions.
      tmuxSync(this.tmuxBin, ["resize-window", "-t", this.sessionName, "-x", String(cols), "-y", String(rows)])
    } catch {
      // Some tmux configs disable resize-window when no client is
      // attached. Fall back to refresh-client which is always allowed.
      try {
        tmuxSync(this.tmuxBin, ["refresh-client", "-C", `${cols}x${rows}`])
      } catch {
        /* best effort */
      }
    }
  }

  capture(): string {
    if (this._killed) return this.lastSnapshot
    return this.captureWithCursorRaw().snapshot
  }

  /**
   * Ask tmux for the cursor's pane-relative coordinates. tmux's
   * `display-message -p -F` interpolates the format spec against the
   * target session — `cursor_x` and `cursor_y` are 0-based and align
   * with what `capture-pane` returned (visible pane row/col), so the
   * renderer can overlay a cursor at `lines[y][x]` directly when
   * scroll offset is 0.
   */
  captureCursor(): CursorPos | null {
    if (this._killed) return null
    return this.captureWithCursorRaw().cursor
  }

  /**
   * Atomic snapshot + cursor read. Critical: `capture-pane` and
   * `display-message` must be issued in ONE tmux command, separated by
   * `;`, so the tmux server processes them back-to-back without
   * yielding to the shell. Two separate `spawnSync` calls leave a
   * window where the shell can move its cursor between the snapshot
   * and the cursor read — which surfaced as the cursor block landing
   * one row above the live prompt right after a command finished
   * (snapshot caught the new prompt, cursor read caught the previous
   * line's still-stale position).
   *
   * Notes on the protocol:
   *   - We deliberately do NOT pass `-J` to capture-pane: tmux reports
   *     `cursor_x` / `cursor_y` against the PHYSICAL pane grid (one
   *     row per terminal grid row), so joining wrapped lines breaks
   *     the (x,y) → render coordinate mapping. With raw capture each
   *     pane row is exactly one rendered line.
   *   - Cursor format ends with a newline, so we strip the trailing
   *     line and parse the marker-prefixed payload. The marker keeps
   *     us safe from a snapshot whose last line happens to look like
   *     two integers.
   */
  private captureWithCursorRaw(): { snapshot: string; cursor: CursorPos | null } {
    // Marker MUST be printable ASCII. tmux's `display-message -F` escapes
    // non-printable bytes (e.g. SOH `\u0001` becomes the literal 4 chars
    // `\001`), so a control-byte fence collides with the escape itself
    // and lastIndexOf never matches — the marker line then leaks into
    // the rendered snapshot. Triple-angle brackets are unlikely to
    // appear in shell output and survive tmux's format filter intact.
    const CURSOR_MARK = "<<<KOBE_CURSOR>>>"
    let out: string
    try {
      out = tmuxSync(this.tmuxBin, [
        "capture-pane",
        // -e keeps the SGR (color/attr) escapes in the output. tmux
        // has already applied every cursor-motion / erase-line code
        // to its internal grid, so the output is "plain text + SGR
        // only" — exactly what the SGR parser in `./sgr.ts` expects.
        // The Terminal pane needs colors back; stripping ANSI was the
        // root cause of "the prompt rendered black-on-black for users
        // with oh-my-zsh."
        "-e",
        "-p",
        "-t",
        this.sessionName,
        ";",
        "display-message",
        "-p",
        "-t",
        this.sessionName,
        "-F",
        `${CURSOR_MARK}#{cursor_x} #{cursor_y}`,
      ])
    } catch {
      return { snapshot: this.lastSnapshot, cursor: null }
    }
    const markIdx = out.lastIndexOf(CURSOR_MARK)
    if (markIdx === -1) return { snapshot: out, cursor: null }
    const snapshot = out.slice(0, markIdx).replace(/\n$/, "")
    const cursorLine = out.slice(markIdx + CURSOR_MARK.length).trim()
    const parts = cursorLine.split(/\s+/)
    const xPart = parts[0]
    const yPart = parts[1]
    if (xPart === undefined || yPart === undefined) return { snapshot, cursor: null }
    const x = Number.parseInt(xPart, 10)
    const y = Number.parseInt(yPart, 10)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { snapshot, cursor: null }
    return { snapshot, cursor: { x, y } }
  }

  kill(): void {
    if (this._killed) return
    this.markDead()
    try {
      // Don't throw if the session was already cleaned up.
      const result = spawnSync(this.tmuxBin, ["kill-session", "-t", this.sessionName], { encoding: "utf8" })
      void result
    } catch {
      /* best effort; we already marked dead */
    }
  }

  /** Internal: tear down listeners + timer + control client; do not touch tmux. */
  private markDead(): void {
    this._killed = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.controlClient) {
      this.controlClient.kill()
      this.controlClient = null
    }
    this.listeners.clear()
  }
}

/* --------------------------------------------------------------------- */
/*  Mock backend (tests only)                                             */
/* --------------------------------------------------------------------- */

/**
 * In-memory PTY for unit tests. No external process. Writes append to
 * an internal buffer; tests can feed "shell output" via `feed()` to
 * drive the listener.
 */
export class MockTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly listeners = new Set<DataListener>()
  private buffer = ""
  private writes: string[] = []
  private _killed = false
  private _cols: number
  private _rows: number
  private _cursor: CursorPos | null = null

  constructor(opts: TaskPtyOpts) {
    this.taskId = opts.taskId
    this.cwd = opts.cwd
    this._cols = opts.cols ?? DEFAULT_COLS
    this._rows = opts.rows ?? DEFAULT_ROWS
  }

  get killed(): boolean {
    return this._killed
  }

  /** Tests inspect what the consumer has written. */
  get writeLog(): readonly string[] {
    return this.writes
  }

  /** Current geometry — exposed for tests to assert resize() worked. */
  get geometry(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows }
  }

  /** Tests use this to push synthetic shell output and observe listeners. */
  feed(data: string): void {
    if (this._killed) return
    this.buffer += data
    for (const cb of this.listeners) {
      try {
        cb(this.buffer, this._cursor)
      } catch {
        /* swallow */
      }
    }
  }

  write(data: string): void {
    if (this._killed) return
    this.writes.push(data)
  }

  onData(cb: DataListener): () => void {
    this.listeners.add(cb)
    if (this.buffer !== "") {
      try {
        cb(this.buffer, this._cursor)
      } catch {
        /* swallow */
      }
    }
    return () => {
      this.listeners.delete(cb)
    }
  }

  resize(cols: number, rows: number): void {
    if (this._killed) return
    this._cols = cols
    this._rows = rows
  }

  capture(): string {
    return this.buffer
  }

  /** Tests can stash a synthetic cursor for the renderer to overlay. */
  setCursor(pos: CursorPos | null): void {
    this._cursor = pos
  }

  captureCursor(): CursorPos | null {
    if (this._killed) return null
    return this._cursor
  }

  kill(): void {
    if (this._killed) return
    this._killed = true
    this.listeners.clear()
  }
}

/* --------------------------------------------------------------------- */
/*  Backend selection                                                     */
/* --------------------------------------------------------------------- */

/**
 * Pick a backend based on `process.env.KOBE_TERMINAL_BACKEND`. Default
 * is `tmux`; `mock` is for tests only and never advertised to users.
 *
 * Centralizing this here means the Solid component constructs `TaskPty`
 * via this factory and tests can swap to mock by setting the env var.
 */
export function createTaskPty(opts: TaskPtyOpts): TaskPtyLike {
  const backend = process.env.KOBE_TERMINAL_BACKEND ?? "tmux"
  if (backend === "mock") return new MockTaskPty(opts)
  return new TmuxTaskPty(opts)
}

/**
 * Type alias used by the Solid component + registry. Today === the
 * common shape; if we ever need to publish concrete extra methods on
 * just one backend, add them here.
 */
export type TaskPty = TaskPtyLike
