/**
 * DaemonTaskPty — the daemon-hosted PTY backend (protocol v4) and the
 * DEFAULT terminal backend.
 *
 * The raw PTY child lives in the kobe daemon (`kobe-daemon/daemon/
 * pty-host.ts`), so quitting the TUI leaves the engine session RUNNING in
 * the background; reopening kobe reattaches and replays the daemon's byte
 * ring buffer into a fresh local xterm — the tmux-persistence behavior
 * without tmux. VT emulation stays in this process (`pty-xterm-base.ts`);
 * only raw bytes cross the socket (`pty.data` frames, base64).
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
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type { PtyDataEventPayload, PtyExitEventPayload, PtyOpenResult } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { TaskPtyOpts } from "./pty-types"
import { XtermTaskPty } from "./pty-xterm-base"

/**
 * One shared daemon connection for every DaemonTaskPty in this process.
 * Deliberately NOT `subscribe`d: pty frames are written directly to the
 * attached connection by the daemon, and this connection must not count
 * as a GUI (the PTY sessions themselves hold the daemon's lifetime).
 * Spawns the daemon if none is running — the terminal pane is the
 * product; it may resurrect an idle-stopped daemon.
 */
let shared: Promise<KobeDaemonClient> | null = null

function getSharedPtyClient(): Promise<KobeDaemonClient> {
  if (shared) return shared
  const p = (async () => {
    const socketPath = await ensureDaemonReachable()
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

export class DaemonTaskPty extends XtermTaskPty {
  private client: KobeDaemonClient | null = null
  private opened = false
  private pendingInput: string[] = []
  private pendingResize: { cols: number; rows: number } | null = null
  private unsubs: (() => void)[] = []

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
        // Daemon died / socket dropped: the pane shows its dead-shell
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
      if (!res.alive) this.remoteGone()
    } catch (err) {
      logClientError("pty-daemon", err)
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
   * Drop this handle, leave the child running in the daemon — the whole
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

  /** The remote child (or the daemon itself) is gone — dead-shell banner. */
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
