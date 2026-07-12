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

import { Unicode11Addon } from "@xterm/addon-unicode11"
import { type IMarker, Terminal as XtermHeadless } from "@xterm/headless"
import { persistedScrollbackRows } from "../../../state/scrollback"
import { encodeWheel } from "./keys-pure"
import {
  type CursorPos,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type DataListener,
  type TaskPtyLike,
  type TaskPtyOpts,
  type TerminalRow,
} from "./pty-types"
import { reconcileTerminalCursor, reconcileTerminalRow, reconcileTerminalRows } from "./terminal-snapshot"
import { xtermLineToChunks } from "./xterm-chunks"
import {
  type SnapshotMeta,
  XtermRefreshTracker,
  dirtyRowsMatchSnapshot,
  snapshotMeta,
  wireXtermChannels,
  xtermCursorHidden,
  xtermSynchronizedOutput,
} from "./xterm-refresh"

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
  private readonly refreshTracker: XtermRefreshTracker
  private publishedMeta: SnapshotMeta | null = null
  /** Scrollback rows resolved from the persisted preference at construction
   * (Settings → General → Terminal) — fixed for this PTY's lifetime. */
  private readonly scrollbackRows: number

  constructor(opts: TaskPtyOpts) {
    this.taskId = opts.taskId
    this.cwd = opts.cwd
    this.cols = opts.cols ?? DEFAULT_COLS
    this.rows = opts.rows ?? DEFAULT_ROWS
    // A restored (previously parked) screen brings its title with it —
    // serialize streams don't carry OSC titles, and the tab strip must not
    // flash back to "shell" on wake.
    if (opts.restore?.title) this._title = opts.restore.title
    this.scrollbackRows = opts.scrollback ?? persistedScrollbackRows()
    this.term = new XtermHeadless({
      allowProposedApi: true,
      cols: this.cols,
      rows: this.rows,
      scrollback: this.scrollbackRows,
    })
    // Unicode 11 width tables: the default (Unicode 6) measures emoji as ONE
    // cell while every modern app — and kobe's own cursor-overlay math in
    // lib/display-width.ts — measures them as TWO, so any emoji in engine
    // output desynced the emulator's cursor/wrap from the drawn overlay.
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = "11"
    this.refreshTracker = new XtermRefreshTracker(this.term)

    wireXtermChannels(this.term, {
      // `muteReplies`: replies triggered while parsing a ring-buffer REPLAY
      // are answers to queries the child asked in the PAST (it already got
      // them, from whatever emulator was attached then). Sending fresh
      // answers now injects unsolicited CPR/DA bytes into the child's
      // stdin — an interactive claude read them as input and scrambled its
      // renderer. Live queries still flow.
      onReply: (data) => {
        if (this._killed || this.muteReplies) return
        try {
          this.transportWrite(data)
        } catch {
          /* best effort — child may have exited */
        }
      },
      onTitle: (title) => {
        if (!title || title === this._title) return
        this._title = title
        for (const cb of this.titleListeners) {
          try {
            cb(title)
          } catch {
            /* one listener must not break the others */
          }
        }
      },
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
      const seq = encodeWheel(
        {
          mouseTracking: modes.mouseTrackingMode !== "none",
          applicationCursorKeys: modes.applicationCursorKeysMode === true,
          alternateScreen: this.term.buffer.active.type === "alternate",
        },
        direction,
        col,
        row,
      )
      if (seq !== null) {
        this.write(seq)
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

  /** Park-capture accessors for persistent backends (see `HostedTaskPty.capturePark`). */
  protected get windowTitle(): string | null {
    return this._title
  }

  protected get scrollback(): number {
    return this.scrollbackRows
  }

  /** Emulator-only resize for the wake feed: the serialized stream must be
   *  parsed at its capture geometry; the child is NOT resized (the host
   *  already runs it at the pane's current size). */
  protected resizeEmulator(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.term.resize(cols, rows)
    this.invalidateScrollbackCache()
    this.refreshTracker.markAll()
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
      this.refreshTracker.markAll()
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
    this.term.write(data, () => {
      if (!this.refreshTracker.supported) this.refreshTracker.markAll()
      this.queueRefresh()
    })
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
      if (!this.refreshTracker.supported) this.refreshTracker.markAll()
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

  private refreshSnapshot(): void {
    if (this._killed) return
    const previousSnapshot = this.snapshot
    const previousCursor = this.cursor
    // Don't snapshot a half-painted frame. Self-reschedule rather than
    // relying solely on the closing write's callback — under rapid redraws
    // a new sync block can open before that write lands, bouncing forever.
    if (xtermSynchronizedOutput(this.term)) {
      this.queueRefresh()
      return
    }
    const active = this.term.buffer.active
    const cursorHidden = xtermCursorHidden(this.term)
    const currentMeta = snapshotMeta(active, this.rows, this.scrollbackRows)
    const nextCursor = reconcileTerminalCursor(
      previousCursor,
      cursorHidden ? null : { x: active.cursorX, y: active.baseY + active.cursorY - currentMeta.start },
    )
    if (
      dirtyRowsMatchSnapshot(
        active,
        previousSnapshot,
        this.publishedMeta,
        currentMeta,
        this.refreshTracker.peek(),
        cursorHidden,
      )
    ) {
      this.snapshotDirty = false
      this.refreshTracker.clear()
      this.publishedMeta = currentMeta
      this.cursor = nextCursor
      if (this.cursor !== previousCursor) this.publishSnapshot()
      return
    }
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
    const start = currentMeta.start
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
      const minLast = !cursorHidden && y === cursorY ? active.cursorX - 1 : -1
      const row: TerminalRow = line ? xtermLineToChunks(line, minLast) : []
      const stableRow = frozen ? reconcileTerminalRow(previousSnapshot[rows.length], row) : row
      rows.push(stableRow)
      if (frozen) cache.set(absBase + y, stableRow)
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
    this.snapshot = reconcileTerminalRows(previousSnapshot, rows)
    this.snapshotDirty = false
    this.refreshTracker.clear()
    this.publishedMeta = currentMeta
    this.cursor = nextCursor
    if (this.snapshot === previousSnapshot && this.cursor === previousCursor) return
    this.publishSnapshot()
  }

  private publishSnapshot(): void {
    for (const cb of this.listeners) {
      try {
        cb(this.snapshot, this.cursor)
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  /** Free the emulator's cell buffers NOW instead of waiting for GC — the
   *  whole point of parking a hidden tab. The last snapshot stays readable
   *  (capture() serves the cached rows; every term-touching path guards on
   *  `_killed`), so the dead-shell banner still shows the final screen. */
  private disposeEmulator(): void {
    try {
      this.term.dispose()
    } catch {
      /* already disposed */
    }
  }

  protected markDead(killProcess: boolean): void {
    if (this._killed) return
    this._killed = true
    this.refreshTracker.dispose()
    this.disposeEmulator()
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
    this.refreshTracker.dispose()
    this.disposeEmulator()
    this.listeners.clear()
    this.exitListeners.clear()
    this.titleListeners.clear()
  }
}
