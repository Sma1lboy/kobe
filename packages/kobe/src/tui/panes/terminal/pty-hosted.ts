/**
 * HostedTaskPty — the pty-host-backed terminal backend (protocol v4) and
 * the DEFAULT backend.
 *
 * The raw PTY child lives in the standalone `kobe pty-host` process
 * (kobe's tmux-server analog, `kobe-daemon/daemon/pty-server.ts`) — NOT
 * in the daemon and NOT in this TUI process. So an engine session
 * survives BOTH quitting the TUI and `kobe daemon restart`; reopening
 * kobe reattaches and replays the host's byte ring buffer into a fresh
 * local xterm. Only `kobe reset` (or the host idle-exiting at zero live
 * sessions) ends the children. VT emulation stays in this process
 * (`pty-xterm-base.ts`); only raw bytes cross the socket (`pty.data`
 * frames, base64).
 *
 * Lifecycle mapping onto {@link TaskPtyLike}:
 *   - `kill()`  → `pty.kill` — ends the REMOTE child (tab close, archive,
 *     reset). This is the "I'm done with this session" path.
 *   - `detach()` → `pty.detach` — drops only this handle; the child keeps
 *     running. App teardown calls this via `registry.detachAll()`.
 *
 * The socket opens asynchronously while the constructor stays sync (the
 * registry contract): input typed before the open completes is queued and
 * flushed after the replay, so nothing is lost or reordered.
 */

import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { ensurePtyHostReachable } from "@sma1lboy/kobe-daemon/client/pty-process"
import type { PtyDataEventPayload, PtyExitEventPayload, PtyOpenResult } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { TaskPtyOpts } from "./pty-types"
import { XtermTaskPty } from "./pty-xterm-base"

/**
 * One shared pty-host connection for every HostedTaskPty in this process
 * (the host speaks the daemon frame grammar, so the same client class
 * works). Spawns the host if none is running — the terminal pane is the
 * product; it may resurrect an idle-exited host.
 */
let shared: Promise<KobeDaemonClient> | null = null

function getSharedPtyClient(): Promise<KobeDaemonClient> {
  if (shared) return shared
  const p = (async () => {
    const socketPath = await ensurePtyHostReachable()
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    client.onLifecycle("close", () => {
      if (shared === p) shared = null
    })
    return client
  })()
  p.catch(() => {
    if (shared === p) shared = null
  })
  shared = p
  return p
}

export class HostedTaskPty extends XtermTaskPty {
  private client: KobeDaemonClient | null = null
  private opened = false
  private pendingInput: string[] = []
  private pendingResize: { cols: number; rows: number } | null = null
  private unsubs: (() => void)[] = []
  /** See {@link TaskPtyLike.deadOnAttach} — set when `pty.open` handed us
   *  a session whose child had already exited (non-empty replay tells a
   *  corpse apart from a failed fresh spawn). */
  deadOnAttach = false

  constructor(opts: TaskPtyOpts) {
    super(opts)
    void this.openRemote(opts)
  }

  private async openRemote(opts: TaskPtyOpts): Promise<void> {
    try {
      const client = await getSharedPtyClient()
      if (this.killed) return
      this.client = client
      this.unsubs.push(
        client.on("pty.data", (frame) => {
          const payload = frame.payload as PtyDataEventPayload
          if (payload.key === this.taskId) this.feed(Buffer.from(payload.data, "base64"))
        }),
        client.on("pty.exit", (frame) => {
          const payload = frame.payload as PtyExitEventPayload
          if (payload.key === this.taskId) this.remoteGone()
        }),
        // Host died / socket dropped: the pane shows its dead-shell
        // banner; the user reopens the tab (or reset) to reattach.
        client.onLifecycle("close", () => this.remoteGone()),
      )
      const res = await client.request<PtyOpenResult>("pty.open", {
        key: this.taskId,
        cwd: this.cwd,
        command: opts.command,
        shell: opts.shell,
        cols: this.cols,
        rows: this.rows,
      })
      if (this.killed) return
      // Replay BEFORE flushing queued input — the ring buffer is the
      // session's past; queued keystrokes are its future.
      if (res.replay.length > 0) this.feed(Buffer.from(res.replay, "base64"))
      this.opened = true
      if (this.pendingResize) {
        const { cols, rows } = this.pendingResize
        this.pendingResize = null
        this.sendResize(cols, rows)
      }
      for (const data of this.pendingInput.splice(0)) this.sendInput(data)
      if (!res.alive) {
        this.deadOnAttach = res.replay.length > 0
        this.remoteGone()
      } else if (res.replay.length > 0) {
        // Reattach to a LIVE session (TUI restart, park-sweep wake): when
        // our geometry matches the host's, no SIGWINCH ever fires and
        // nothing tells the app to repaint what the replay painted — a
        // long session's ring-buffer tail starts mid-stream, so the
        // replayed screen is garbage until the next full redraw. Wiggle
        // one row and back to force it (tmux repaints on attach the same
        // way); a same-size TIOCSWINSZ raises no signal, it must move.
        // ponytail: a 1-row-tall pane can't wiggle — never real.
        this.sendResize(this.cols, Math.max(1, this.rows - 1))
        this.sendResize(this.cols, this.rows)
      }
    } catch (err) {
      logClientError("pty-hosted", err)
      this.remoteGone()
    }
  }

  protected transportWrite(data: string): void {
    if (!this.opened) {
      this.pendingInput.push(data)
      return
    }
    this.sendInput(data)
  }

  protected transportResize(cols: number, rows: number): void {
    if (!this.opened) {
      this.pendingResize = { cols, rows }
      return
    }
    this.sendResize(cols, rows)
  }

  /** kill() path — end the REMOTE child too (tab close / archive / reset). */
  protected transportKill(): void {
    const client = this.client
    if (client) void client.request("pty.kill", { key: this.taskId }).catch(() => {})
    this.cleanup()
  }

  /**
   * kill() must forget the REMOTE session record even when this handle is
   * already dead: the host keeps an exited session under its key
   * (post-mortem reattach), and the base kill() early-returns on `_killed`
   * so `pty.kill` never reached the host. The next `pty.open` under the
   * same key then reattached the corpse (spawn spec ignored, alive:false)
   * instead of spawning fresh — which turned "engine exit → degrade to
   * shell" into the tab closing itself, and made F5 reset of a dead shell
   * a no-op.
   */
  override kill(): void {
    if (this.killed) {
      void this.client?.request("pty.kill", { key: this.taskId }).catch(() => {})
      return
    }
    super.kill()
  }

  /**
   * Drop this handle, leave the child running in the pty host — the whole
   * point of the backend. Called by `registry.detachAll()` on app exit.
   */
  detach(): void {
    const client = this.client
    if (client) void client.request("pty.detach", { key: this.taskId }).catch(() => {})
    this.cleanup()
    this.silentDispose()
  }

  private sendInput(data: string): void {
    void this.client?.request("pty.write", { key: this.taskId, data }).catch(() => this.remoteGone())
  }

  private sendResize(cols: number, rows: number): void {
    void this.client?.request("pty.resize", { key: this.taskId, cols, rows }).catch(() => {})
  }

  /** The remote child (or the host itself) is gone — dead-shell banner. */
  private remoteGone(): void {
    this.cleanup()
    this.markDead(false)
  }

  private cleanup(): void {
    for (const unsub of this.unsubs.splice(0)) {
      try {
        unsub()
      } catch {
        /* best effort */
      }
    }
  }
}
