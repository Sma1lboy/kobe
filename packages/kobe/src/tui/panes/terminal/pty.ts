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

/** Listener for new pane snapshots. Receives the full visible pane on each tick. */
export type DataListener = (snapshot: string) => void

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
const DEFAULT_POLL_MS = 80
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
 * Concrete tmux-backed PTY. One tmux session per instance, named after
 * the task id. The session is created on construction; `kill()` closes
 * it. Output is observed via a polling loop on `capture-pane`.
 */
export class TmuxTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  private readonly tmuxBin: string
  private readonly sessionName: string
  private readonly listeners = new Set<DataListener>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastSnapshot = ""
  private _killed = false
  private cols: number
  private rows: number
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

    assertTmuxAvailable(this.tmuxBin)

    const shell = opts.shell ?? defaultShell()

    // If a session with this name already exists (e.g. kobe restarted
    // and the task was still in_progress), attach to it instead of
    // failing. tmux's `has-session` exits 0 when present, 1 when absent.
    const has = spawnSync(this.tmuxBin, ["has-session", "-t", this.sessionName], { encoding: "utf8" })
    if (has.status !== 0) {
      // Create new detached session at the requested cwd, with the
      // requested shell, with our chosen geometry. -d keeps it
      // detached; the terminal pane in kobe captures its content.
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
    } else {
      // Pre-existing session — just resize to our requested dims so
      // the captured pane lines up with the renderer.
      this.resize(this.cols, this.rows)
    }

    // Begin polling for output.
    const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
    this.pollTimer = setInterval(() => {
      if (this._killed) return
      try {
        const snap = this.capture()
        if (snap !== this.lastSnapshot) {
          this.lastSnapshot = snap
          for (const cb of this.listeners) {
            try {
              cb(snap)
            } catch {
              // never let one listener kill the rest
            }
          }
        }
      } catch {
        // Capture can fail if the session was killed externally; fall
        // through and stop polling.
        this.markDead()
      }
    }, pollMs)
    // Don't keep the event loop alive on the poll timer alone.
    this.pollTimer.unref?.()
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

    // Snapshot the data NOW so the closure below doesn't see a
    // mutated value across queue ticks.
    const bytes = Buffer.from(data, "utf8")

    // Append to the serialized queue. Each chunk waits for the prior
    // tmux spawn to exit before launching its own. The queue captures
    // ordering across both intra-call chunks AND back-to-back
    // `write()` invocations.
    this.writeQueue = this.writeQueue.then(() => this.sendBytesSerialized(bytes))
    // Swallow rejections so a transient send-keys failure doesn't
    // poison the queue forever.
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
        cb(this.lastSnapshot)
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
    // -p prints to stdout; -e preserves escape codes if we ever want
    // them, but we strip via the renderer. -J joins wrapped lines.
    return tmuxSync(this.tmuxBin, ["capture-pane", "-p", "-J", "-t", this.sessionName])
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
    try {
      const out = tmuxSync(this.tmuxBin, [
        "display-message",
        "-p",
        "-t",
        this.sessionName,
        "-F",
        "#{cursor_x} #{cursor_y}",
      ])
      const trimmed = out.trim()
      if (!trimmed) return null
      const parts = trimmed.split(/\s+/)
      if (parts.length < 2) return null
      const xPart = parts[0]
      const yPart = parts[1]
      if (xPart === undefined || yPart === undefined) return null
      const x = Number.parseInt(xPart, 10)
      const y = Number.parseInt(yPart, 10)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return { x, y }
    } catch {
      return null
    }
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

  /** Internal: tear down listeners + timer; do not touch tmux. */
  private markDead(): void {
    this._killed = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
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
        cb(this.buffer)
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
        cb(this.buffer)
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
