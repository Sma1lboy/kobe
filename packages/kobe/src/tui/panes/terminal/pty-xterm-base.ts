/**
 * Shared xterm-headless emulation for PTY backends.
 *
 * `BunTerminalTaskPty` (local child) and `DaemonTaskPty` (daemon-hosted
 * child, protocol v4) differ ONLY in transport — where raw bytes come from
 * and where input/resize/kill go. Everything VT lives here once: the
 * headless emulator, the query-reply channel, title tracking, snapshot
 * refresh with synchronized-output handling, wheel/paste encoding.
 *
 * Subclass contract: call {@link feed} with raw child output, implement
 * the three `transport*` hooks, and call {@link markDead} when the child
 * ends. Transport hooks may throw — callers here wrap them and degrade to
 * `markDead`, matching the old Bun backend's behavior.
 */

import { type IMarker, Terminal as XtermHeadless } from "@xterm/headless"
import { persistedScrollbackRows } from "../../../state/scrollback"
import {
  type CursorPos,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type DataListener,
  type TaskPtyLike,
  type TaskPtyOpts,
  type TerminalRow,
} from "./pty-types"
import { xtermLineToChunks } from "./xterm-chunks"

export abstract class XtermTaskPty implements TaskPtyLike {
  readonly taskId: string
  readonly cwd: string
  protected readonly term: XtermHeadless
  private readonly listeners = new Set<DataListener>()
  private readonly exitListeners = new Set<() => void>()
  private readonly titleListeners = new Set<(title: string) => void>()
  private snapshot: readonly TerminalRow[] = []
  private cursor: CursorPos | null = null
  /** Output arrived while nobody was subscribed — snapshot is stale and
   * will be rebuilt lazily on the next capture()/subscribe. Keeps the N
   * background sessions of a multi-task workspace from re-converting
   * their full grid+scrollback at output cadence for a consumer (the
   * 1.5s turn poll) that only reads via capture(). */
  private snapshotDirty = false
  /** Frozen-scrollback conversion cache: absolute line id → converted row.
   * A line above `baseY` can never change again (apps can only address the
   * live grid), so re-converting the full scrollback margin on every
   * refresh was ~80% wasted work under streaming. Absolute ids ride
   * `anchor` — an xterm marker whose `.line` tracks buffer trimming, so an
   * id keeps naming the same physical line across scrollback trim shifts.
   * Wiped on resize (reflow rewrites history) and whenever the anchor dies
   * (buffer reset trims it). */
  private readonly scrollbackCache = new Map<number, TerminalRow>()
  private anchor: IMarker | undefined
  private anchorId = 0
  private _title: string | null = null
  /** Since when the pty has had zero data subscribers (epoch ms), null
   * while watched. Fresh instances start "unwatched now" — the mounting
   * pane subscribes within a tick; a handle that never gets a subscriber
   * (defensive acquire) should age toward the park sweep, not hide from
   * it. See `TaskPtyLike.unwatchedSinceMs`. */
  private _unwatchedSince: number | null = Date.now()
  private _killed = false
  /** True while a ring-buffer replay is being parsed — see the reply
   * channel in the constructor. Flips back in the replay write's
   * completion callback, which xterm fires strictly after that chunk's
   * parse and before any later `feed` chunk's. */
  private muteReplies = false
  protected cols: number
  protected rows: number
  private refreshQueued = false
  /** Scrollback rows resolved from the persisted preference at construction
   * (Settings → General → Terminal) — fixed for this PTY's lifetime. */
  private readonly scrollbackRows: number

  constructor(opts: TaskPtyOpts) {
    this.taskId = opts.taskId
    this.cwd = opts.cwd
    this.cols = opts.cols ?? DEFAULT_COLS
    this.rows = opts.rows ?? DEFAULT_ROWS
    this.scrollbackRows = opts.scrollback ?? persistedScrollbackRows()
    this.term = new XtermHeadless({
      allowProposedApi: true,
      cols: this.cols,
      rows: this.rows,
      scrollback: this.scrollbackRows,
    })

    // Reply channel: xterm emits responses to the program's terminal
    // queries (Primary DA `\x1b[c`, cursor-position report `\x1b[6n`,
    // status DSR, etc.) via `onData`. These MUST flow back to the
    // child's stdin — an interactive app like `claude` queries the
    // terminal on startup to detect its type/capabilities and to sync
    // its cursor model. Dropping the replies left claude on a fallback
    // path whose relative cursor-move + erase-to-EOL redraw landed on
    // the wrong rows, half-erasing its input-box rule.
    this.term.onData((data) => {
      // `muteReplies`: replies triggered while parsing a ring-buffer REPLAY
      // are answers to queries the child asked in the PAST (it already got
      // them, from whatever emulator was attached then). Sending fresh
      // answers now injects unsolicited CPR/DA bytes into the child's
      // stdin — an interactive claude read them as input and scrambled its
      // renderer. Live queries still flow.
      if (this._killed || this.muteReplies) return
      try {
        this.transportWrite(data)
      } catch {
        /* best effort — child may have exited */
      }
    })

    // Window-title tracking (OSC 0/2) — xterm-headless already parses
    // these escapes internally, so the split-leaf corner tag can show
    // "vim"/"htop"/whatever's actually running instead of a static
    // "shell" (see `terminal-tabs-core.ts`'s `splitLeafNames`).
    this.term.onTitleChange((title) => {
      if (!title || title === this._title) return
      this._title = title
      for (const cb of this.titleListeners) {
        try {
          cb(title)
        } catch {
          /* one listener must not break the others */
        }
      }
    })
  }

  /** Send input bytes to the child over this backend's transport. */
  protected abstract transportWrite(data: string): void
  /** Propagate a resize to the child's PTY. */
  protected abstract transportResize(cols: number, rows: number): void
  /** End the child (kill()-path only — never called on observed exits). */
  protected abstract transportKill(): void

  get killed(): boolean {
    return this._killed
  }

  write(data: string): void {
    if (this._killed || data.length === 0) return
    try {
      this.transportWrite(data)
    } catch {
      this.markDead(false)
    }
  }

  onExit(cb: () => void): () => void {
    if (this._killed) {
      cb()
      return () => {}
    }
    this.exitListeners.add(cb)
    return () => {
      this.exitListeners.delete(cb)
    }
  }

  onTitleChange(cb: (title: string) => void): () => void {
    this.titleListeners.add(cb)
    if (this._title) {
      try {
        cb(this._title)
      } catch {
        /* one listener must not break the others */
      }
    }
    return () => {
      this.titleListeners.delete(cb)
    }
  }

  paste(text: string): void {
    if (this._killed || text.length === 0) return
    let bracketed = false
    try {
      bracketed = this.term.modes.bracketedPasteMode === true
    } catch {
      /* mode probe is best-effort */
    }
    this.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text)
  }

  wheel(direction: "up" | "down", col: number, row: number): boolean {
    if (this._killed) return false
    try {
      const modes = this.term.modes
      if (modes.mouseTrackingMode !== "none") {
        // SGR (1006) wheel encoding — xterm.js doesn't expose which
        // encoding the app negotiated, and every current TUI (claude,
        // vim, less with --mouse) requests SGR, so it's assumed.
        const btn = direction === "up" ? 64 : 65
        this.write(`\x1b[<${btn};${Math.max(1, col)};${Math.max(1, row)}M`)
        return true
      }
      if (this.term.buffer.active.type === "alternate") {
        // Fullscreen app without mouse reporting: the classic emulator
        // fallback of 3 arrow keys per wheel tick.
        const arrow =
          modes.applicationCursorKeysMode === true
            ? direction === "up"
              ? "\x1bOA"
              : "\x1bOB"
            : direction === "up"
              ? "\x1b[A"
              : "\x1b[B"
        this.write(arrow.repeat(3))
        return true
      }
    } catch {
      /* mode probe is best-effort */
    }
    return false
  }

  onData(cb: DataListener): () => void {
    // Refresh BEFORE registering so a lazily-deferred snapshot doesn't
    // double-notify the new subscriber (once from the rebuild's listener
    // loop, once from the prime below).
    this.ensureFreshSnapshot()
    this.listeners.add(cb)
    this._unwatchedSince = null
    if (this.snapshot.length > 0) {
      try {
        cb(this.snapshot, this.cursor)
      } catch {
        /* one listener must not break the others */
      }
    }
    return () => {
      this.listeners.delete(cb)
      if (this.listeners.size === 0 && this._unwatchedSince === null) this._unwatchedSince = Date.now()
    }
  }

  unwatchedSinceMs(): number | null {
    return this._unwatchedSince
  }

  resize(cols: number, rows: number): void {
    if (this._killed) return
    this.cols = cols
    this.rows = rows
    try {
      this.term.resize(cols, rows)
      // Reflow rewraps history — every cached scrollback row is stale.
      this.invalidateScrollbackCache()
      this.transportResize(cols, rows)
      this.refreshSnapshot()
    } catch {
      this.markDead(false)
    }
  }

  private invalidateScrollbackCache(): void {
    this.scrollbackCache.clear()
    this.anchor?.dispose()
    this.anchor = undefined
    this.anchorId = 0
  }

  capture(): readonly TerminalRow[] {
    this.ensureFreshSnapshot()
    return this.snapshot
  }

  captureCursor(): CursorPos | null {
    this.ensureFreshSnapshot()
    return this.cursor
  }

  /** Rebuild a lazily-deferred snapshot before handing it out. Mid-
   * synchronized-output the rebuild is skipped (same torn-frame rule as
   * the live path) — the snapshot stays dirty and the caller gets the
   * last whole frame. */
  private ensureFreshSnapshot(): void {
    if (!this.snapshotDirty || this._killed) return
    this.refreshSnapshot()
  }

  kill(): void {
    if (this._killed) return
    this.markDead(true)
  }

  /** Hand raw child output to xterm. Bytes, not decoded strings: xterm's
   * parser keeps a streaming UTF-8 decoder across `write` calls, so a
   * multi-byte glyph (box-drawing `─`, claude's status icons) split across
   * a chunk boundary is reassembled correctly. Decoding each chunk here
   * instead corrupted any glyph straddling a boundary. */
  protected feed(data: string | Uint8Array): void {
    if (this._killed) return
    this.term.write(data, () => this.queueRefresh())
  }

  /** Feed a ring-buffer REPLAY: parsed like live output, but the emulator's
   * auto-replies are muted for exactly this chunk's parse (see the reply
   * channel). Live chunks fed after this parse in FIFO order, so the
   * un-mute callback lands between the replay's parse and theirs. */
  protected feedReplay(data: string | Uint8Array): void {
    if (this._killed) return
    this.muteReplies = true
    this.term.write(data, () => {
      this.muteReplies = false
      this.queueRefresh()
    })
  }

  private queueRefresh(): void {
    // No subscriber → don't pay the full grid+scrollback conversion at
    // output cadence; mark stale and rebuild on capture()/subscribe.
    if (this.listeners.size === 0) {
      this.snapshotDirty = true
      return
    }
    if (this.refreshQueued) return
    this.refreshQueued = true
    setTimeout(() => {
      this.refreshQueued = false
      this.refreshSnapshot()
    }, 16)
  }

  /**
   * Is xterm currently mid-`?2026` synchronized-output block? Apps that
   * paint atomically (interactive `claude` opens ~45 of these per
   * prompt) write a frame in two halves; snapshotting between them
   * renders a torn intermediate state. We skip the refresh while the
   * mode is set — the closing `?2026l` is itself a write that re-queues
   * a refresh once the frame is whole.
   */
  private inSynchronizedOutput(): boolean {
    try {
      return this.term.modes.synchronizedOutputMode === true
    } catch {
      return false
    }
  }

  /**
   * Has the app hidden the cursor via `?25l`? Streaming `claude` hides
   * the cursor while it paints; an unconditional inverse cursor cell on
   * top of that looks like a stray glyph. xterm tracks this on its
   * core service — not surfaced through the public typings, hence the
   * narrow internal reach.
   */
  private cursorHidden(): boolean {
    try {
      const core = (
        this.term as unknown as {
          _core?: { coreService?: { isCursorHidden?: boolean } }
        }
      )._core
      return core?.coreService?.isCursorHidden === true
    } catch {
      return false
    }
  }

  private refreshSnapshot(): void {
    if (this._killed) return
    // Don't snapshot a half-painted frame. Self-reschedule rather than
    // relying solely on the closing write's callback — under rapid redraws
    // a new sync block can open before that write lands, bouncing forever.
    if (this.inSynchronizedOutput()) {
      this.queueRefresh()
      return
    }
    const active = this.term.buffer.active
    // Alt screen has no scrollback (baseY 0) — every row is live, nothing
    // to cache. The normal buffer's anchor/cache are left untouched so
    // they're still valid when the fullscreen app exits.
    const alt = active.type === "alternate"
    if (!alt && (this.anchor === undefined || this.anchor.isDisposed)) {
      // Fresh epoch (first refresh, or the anchor was trimmed by a buffer
      // reset): wipe the stale mapping and anchor BEFORE converting, so
      // this very pass already populates the cache.
      this.scrollbackCache.clear()
      const fresh = this.term.registerMarker(0)
      if (fresh) {
        this.anchor = fresh
        this.anchorId = fresh.line
      }
    }
    const anchorAlive = !alt && this.anchor !== undefined && !this.anchor.isDisposed
    // Absolute id of buffer line y — only meaningful while the anchor lives.
    const absBase = anchorAlive ? this.anchorId - (this.anchor as IMarker).line : 0
    const cache = this.scrollbackCache
    const rows: TerminalRow[] = []
    const cursorY = active.baseY + active.cursorY
    const start = Math.max(0, active.length - (this.rows + this.scrollbackRows))
    for (let y = start; y < active.length; y++) {
      const frozen = anchorAlive && y < active.baseY
      if (frozen) {
        const cached = cache.get(absBase + y)
        if (cached) {
          rows.push(cached)
          continue
        }
      }
      const line = active.getLine(y)
      const minLast = y === cursorY ? active.cursorX - 1 : -1
      const row: TerminalRow = line ? xtermLineToChunks(line, minLast) : []
      rows.push(row)
      if (frozen) cache.set(absBase + y, row)
    }
    if (anchorAlive) {
      // Drop ids that scrolled past the window so the map stays ≤ margin.
      const min = absBase + start
      for (const id of cache.keys()) if (id < min) cache.delete(id)
    }
    if (!alt) {
      // Re-anchor at the cursor line: it survives until it trims through
      // the whole margin, and every refresh renews it long before that.
      const next = this.term.registerMarker(0)
      if (next) {
        this.anchorId = anchorAlive ? absBase + next.line : 0
        this.anchor?.dispose()
        this.anchor = next
      }
      // registerMarker can return undefined — keep the old anchor then.
    }
    this.snapshot = rows
    this.snapshotDirty = false
    // A hidden cursor (`?25l`) reports as null so the pane draws no
    // inverse cursor cell — same contract as a backend that can't
    // report a cursor at all.
    this.cursor = this.cursorHidden() ? null : { x: active.cursorX, y: active.baseY + active.cursorY - start }
    for (const cb of this.listeners) {
      try {
        cb(this.snapshot, this.cursor)
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  protected markDead(killProcess: boolean): void {
    if (this._killed) return
    this._killed = true
    if (killProcess) {
      try {
        this.transportKill()
      } catch {
        /* best effort */
      }
    }
    const exitCbs = [...this.exitListeners]
    this.listeners.clear()
    this.exitListeners.clear()
    for (const cb of exitCbs) {
      try {
        cb()
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  /**
   * Mark this handle dead WITHOUT firing exit listeners or touching the
   * child — the detach path (app teardown wants the daemon-hosted child
   * to keep running, and must not trigger dead-shell UI reactions
   * mid-teardown). Local-only backends fall back to kill().
   */
  protected silentDispose(): void {
    this._killed = true
    this.listeners.clear()
    this.exitListeners.clear()
    this.titleListeners.clear()
  }
}
