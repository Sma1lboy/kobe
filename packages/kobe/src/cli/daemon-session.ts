/**
 * Daemon session boilerplate for short-lived CLI processes.
 *
 * Every `kobe <cmd>` invocation that talks to the daemon repeats the same
 * three steps: connect (auto-starting the daemon when allowed), do the
 * work, close the socket on the way out — success OR error. This module
 * owns that lifecycle in one place so a command never leaks a socket and
 * never re-implements the connect/cleanup dance.
 *
 * Today's consumer is `api-cmd.ts`; `daemon-cmd.ts` / `hook-cmd.ts` keep
 * their hand-rolled equivalents for now (see the follow-up in the session
 * notes) — the `mode` option below already covers both of their patterns:
 *
 *   - `"start"` (default): connect, spawning the daemon if absent — the
 *     `connectOrStartDaemon` path `kobe api` uses.
 *   - `"require-running"`: connect ONLY to an already-live daemon, never
 *     spawn one — the `connectIfRunning` contract `kobe hook` relies on
 *     (a git hook must not boot a daemon as a side effect). Resolves
 *     `null` instead of throwing when no daemon answers.
 */

import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { connectIfRunning, connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type {
  ChannelName,
  ChannelPayloads,
  DaemonRequestName,
  SubscribeRole,
} from "@sma1lboy/kobe-daemon/daemon/protocol"

/**
 * The narrow client surface a CLI verb handler is allowed to touch:
 * request/response RPC plus the subscribe + channel push needed to read
 * replayed channel state (e.g. the active task). `KobeDaemonClient`
 * satisfies it structurally; tests substitute a fake that records
 * requests instead of opening a socket.
 */
export interface DaemonRpc {
  request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T>
  subscribe(opts?: { channels?: readonly ChannelName[]; role?: SubscribeRole }): Promise<unknown>
  onChannel<C extends ChannelName>(channel: C, handler: (payload: ChannelPayloads[C]) => void): () => void
}

/** An open connection plus the one cleanup hook the caller must run. */
export interface DaemonSession {
  readonly client: KobeDaemonClient
  /** Idempotent: closes the socket; safe to call from a `finally`. */
  close(): void
}

export interface DaemonSessionOptions {
  /** `"start"` (default) auto-spawns an absent daemon; `"require-running"` never spawns. */
  readonly mode?: "start" | "require-running"
}

/**
 * Open a daemon session. In `"start"` mode this throws when the daemon
 * cannot be reached or started (the caller maps that to its own error
 * surface); in `"require-running"` mode an absent daemon resolves `null`.
 */
export async function openDaemonSession(opts?: { readonly mode?: "start" }): Promise<DaemonSession>
export async function openDaemonSession(opts: DaemonSessionOptions): Promise<DaemonSession | null>
export async function openDaemonSession(opts: DaemonSessionOptions = {}): Promise<DaemonSession | null> {
  const client = opts.mode === "require-running" ? await connectIfRunning() : await connectOrStartDaemon()
  if (!client) return null
  return { client, close: () => client.close() }
}

/**
 * Run `work` against an open session and ALWAYS close the socket — on
 * success, on a thrown error, and on a rejected promise. `work` receives
 * `null` when `mode: "require-running"` found no live daemon (it still
 * runs, mirroring the non-spawning hook contract where absence is a
 * normal, non-error outcome).
 */
export async function withDaemonSession<T>(
  work: (client: KobeDaemonClient | null) => Promise<T>,
  opts: DaemonSessionOptions = {},
): Promise<T> {
  const session = await openDaemonSession(opts)
  try {
    return await work(session?.client ?? null)
  } finally {
    session?.close()
  }
}
