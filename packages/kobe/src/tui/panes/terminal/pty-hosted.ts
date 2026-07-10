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

/**
 * Key → live handles, for O(1) inbound routing. The client's `emit()` walks
 * its whole `pty.data`/`pty.exit` handler Set per frame, so one `on()` per
 * open tab made every interactive `claude` chunk cost N handler calls +
 * N key-compares (N-1 pure rejections) on the busiest path. Instead we
 * install ONE dispatcher per shared client (see `installDispatch`) that
 * does a single map lookup. Each handle adds itself here on open and the
 * `cleanup()` teardown route (`detach`/`kill`/`park`/socket-close all pass
 * through it) removes it — so a dead tab never receives a stray chunk.
 *
 * A SET per key, not a single handle: two live handles for one key are
 * legal (a second viewer of the same session), and a single-slot map let
 * the newcomer silently STEAL the route — the first handle froze on its
 * last frame with the child still streaming (the "UI is gone but it's
 * still running" bug). Every handle for the key gets every frame; each
 * keeps its own xterm.
 */
const hostedByKey = new Map<string, Set<HostedTaskPty>>()

/** Register `handle` as a live route for its key. */
function routeAdd(handle: HostedTaskPty): void {
  let set = hostedByKey.get(handle.taskId)
  if (!set) {
    set = new Set()
    hostedByKey.set(handle.taskId, set)
  }
  set.add(handle)
}

/** Drop `handle` from the route table. Returns how many siblings remain. */
function routeRemove(handle: HostedTaskPty): number {
  const set = hostedByKey.get(handle.taskId)
  if (!set) return 0
  set.delete(handle)
  if (set.size === 0) hostedByKey.delete(handle.taskId)
  return set.size
}

/** Guards the one-time dispatcher install per client instance. */
const dispatchInstalled = new WeakSet<KobeDaemonClient>()

/**
 * Install the single per-frame router on a shared client. Both `pty.data`
 * and `pty.exit` fan out to exactly one map lookup; unknown keys (a dead
 * handle's late frame, a key from another process) drop silently — the same
 * behavior the old per-handle `payload.key === this.taskId` guard gave, but
 * O(1) instead of O(open-tabs).
 */
function installDispatch(client: KobeDaemonClient): void {
  if (dispatchInstalled.has(client)) return
  dispatchInstalled.add(client)
  client.on("pty.data", (frame) => {
    const payload = frame.payload as PtyDataEventPayload
    const handles = hostedByKey.get(payload.key)
    if (handles) for (const handle of handles) handle.feedFrame(payload.data)
  })
  client.on("pty.exit", (frame) => {
    const payload = frame.payload as PtyExitEventPayload
    const handles = hostedByKey.get(payload.key)
    // Copy: remoteGone → cleanup mutates the set mid-iteration.
    if (handles) for (const handle of [...handles]) handle.remoteGone()
  })
}

function getSharedPtyClient(): Promise<KobeDaemonClient> {
  if (shared) return shared
  const p = (async () => {
    const socketPath = await ensurePtyHostReachable()
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    installDispatch(client)
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
      // Route inbound frames through the shared O(1) dispatcher (installed
      // on the client in getSharedPtyClient) instead of a per-handle
      // `on("pty.data")` that the client would walk for every tab per chunk.
      routeAdd(this)
      this.unsubs.push(
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
      // session's past; queued keystrokes are its future. feedReplay, not
      // feed: the replayed stream contains the child's PAST terminal
      // queries, and answering them again from this fresh emulator would
      // inject stray CPR/DA into the child's stdin.
      if (res.replay.length > 0) this.feedReplay(Buffer.from(res.replay, "base64"))
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
        // Reattach to a LIVE session (TUI restart): when our geometry
        // matches the host's, no SIGWINCH ever fires and nothing tells
        // the app to repaint what the replay painted — a long session's
        // ring-buffer tail starts mid-stream, so the replayed screen is
        // garbage until the next full redraw. Wiggle one row and back to
        // force it (tmux repaints on attach the same way); a same-size
        // TIOCSWINSZ raises no signal, it must move.
        // ponytail: a 1-row-tall pane can't wiggle — never real.
        this.sendResize(this.cols, Math.max(1, this.rows - 1))
        // Back-to-back resizes COALESCE: the child gets ONE SIGWINCH,
        // reads the already-restored size, sees "unchanged", and skips
        // the repaint (measured: 2 zero-gap resizes → 1 signal at the
        // final size). Wait for the child's shrink repaint to actually
        // arrive before restoring; the timeout covers children that
        // don't repaint on WINCH at all (a plain shell).
        await this.nextDataOrTimeout(200)
        if (!this.killed) this.sendResize(this.cols, this.rows)
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
    this.cleanup()
    // The host keeps ONE sink per (key, connection) — shared by every local
    // handle for the key. Detach the host side only when we were the LAST
    // local viewer; sending it with a sibling still attached would starve
    // the survivor's stream.
    const siblings = hostedByKey.get(this.taskId)?.size ?? 0
    if (client && siblings === 0) void client.request("pty.detach", { key: this.taskId }).catch(() => {})
    this.silentDispose()
  }

  private sendInput(data: string): void {
    void this.client?.request("pty.write", { key: this.taskId, data }).catch(() => this.remoteGone())
  }

  private sendResize(cols: number, rows: number): void {
    void this.client?.request("pty.resize", { key: this.taskId, cols, rows }).catch(() => {})
  }

  /** One-shot resolver armed by {@link nextDataOrTimeout}. */
  private dataWaiter: (() => void) | null = null

  /** Resolve on the next inbound `pty.data` frame, or after `ms`. */
  private nextDataOrTimeout(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.dataWaiter = null
        resolve()
      }, ms)
      this.dataWaiter = () => {
        this.dataWaiter = null
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /**
   * Decode + feed one inbound `pty.data` frame. Public so the module-level
   * dispatcher (getSharedPtyClient) can route by key; not for outside use.
   */
  feedFrame(dataB64: string): void {
    this.dataWaiter?.()
    this.feed(Buffer.from(dataB64, "base64"))
  }

  /**
   * The remote child (or the host itself) is gone — dead-shell banner.
   * Public for the shared dispatcher's `pty.exit` route; also the local
   * lifecycle-close reaction.
   */
  remoteGone(): void {
    this.cleanup()
    this.markDead(false)
  }

  private cleanup(): void {
    // Drop our route entry FIRST so no in-flight frame can reach a torn-down
    // handle — every teardown route (detach/kill/park/socket-close) lands
    // here, so this is the single place the registration is undone.
    routeRemove(this)
    for (const unsub of this.unsubs.splice(0)) {
      try {
        unsub()
      } catch {
        /* best effort */
      }
    }
  }
}
