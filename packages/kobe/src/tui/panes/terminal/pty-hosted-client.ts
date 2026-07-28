/**
 * Shared pty-host connection + O(1) inbound routing for `HostedTaskPty`
 * (split from `pty-hosted.ts` — the handle class stays there; this module
 * owns everything process-wide: the one socket, the frame dispatcher, and
 * the key → handle route table).
 */

import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { ensurePtyHostReachable } from "@sma1lboy/kobe-daemon/client/pty-process"
import type { PtyDataEventPayload, PtyExitEventPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { defaultShell } from "./pty-types"

/** The slice of a `HostedTaskPty` the dispatcher routes frames into. */
export interface HostedRoute {
  readonly taskId: string
  feedFrame(dataB64: string): void
  remoteExited(pid: number | null | undefined): void
}

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
const hostedByKey = new Map<string, Set<HostedRoute>>()

/** Register `handle` as a live route for its key. */
export function routeAdd(handle: HostedRoute): void {
  let set = hostedByKey.get(handle.taskId)
  if (!set) {
    set = new Set()
    hostedByKey.set(handle.taskId, set)
  }
  set.add(handle)
}

/** Drop `handle` from the route table. Returns how many siblings remain. */
export function routeRemove(handle: HostedRoute): number {
  const set = hostedByKey.get(handle.taskId)
  if (!set) return 0
  set.delete(handle)
  if (set.size === 0) hostedByKey.delete(handle.taskId)
  return set.size
}

/** How many live handles are currently routed for `key`. */
export function routeCount(key: string): number {
  return hostedByKey.get(key)?.size ?? 0
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
    // Copy: remoteExited → cleanup mutates the set mid-iteration.
    if (handles) for (const handle of [...handles]) handle.remoteExited(payload.pid)
  })
}

export function getSharedPtyClient(): Promise<KobeDaemonClient> {
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

/**
 * Ask the pty host to pre-spawn one idle shell for `cwd` (`pty.warm`) so
 * the next shell-wrapped engine tab adopts an ALREADY-initialized shell
 * (rc files done) instead of paying shell startup. Fire-and-forget and
 * best-effort: a host that predates the verb (or no hosted backend at
 * all) simply means the next spawn is cold.
 */
export function warmHostedShell(cwd: string, shell: string = defaultShell()): void {
  if ((process.env.KOBE_TERMINAL_BACKEND ?? "hosted") !== "hosted") return
  void getSharedPtyClient()
    .then((client) => client.request("pty.warm", { cwd, shell }))
    .catch(() => {})
}
