/**
 * Tiny shared helpers every handler module (and several inline handlers in
 * the {@link VERBS} table) reach for. Split out of `api-cmd.ts` (see that
 * file's header) into its own module — rather than folded into one handler
 * file — because `verbs.ts` needs `simpleRpc` for its inline CRUD verbs
 * without depending on any one handler group.
 */

import type { DaemonRpc } from "../daemon-session.ts"
import { ApiError, type VerbContext } from "./types.ts"

/** The daemon RPC surface, or the canonical "daemon required" error for an offline call. */
export function daemonOf(ctx: VerbContext): DaemonRpc {
  if (!ctx.client) throw new ApiError("daemon required", "BAD_DAEMON")
  return ctx.client
}

/** Fire one daemon RPC and return its raw payload (the generic CRUD shape). */
export async function simpleRpc(ctx: VerbContext, name: string, payload: Record<string, unknown>): Promise<unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: the protocol's request name is a finite union; this is the one generic call site.
  return daemonOf(ctx).request(name as any, payload)
}

/**
 * `pty-list` — inventory of the standalone pty host's sessions (key, pid,
 * command, live OSC window title — the same "实时进程名" stream the TUI tab
 * strip shows). Talks to the PTY HOST socket, not the daemon (offline verb),
 * and never spawns a host: no host running simply means no sessions.
 * Moved here from `verbs.ts` verbatim to keep that file under the size cap.
 */
export async function handlePtyList(): Promise<unknown> {
  const [{ KobeDaemonClient }, { defaultPtyHostSocketPath }] = await Promise.all([
    import("@sma1lboy/kobe-daemon/client"),
    import("@sma1lboy/kobe-daemon/daemon/paths"),
  ])
  const client = new KobeDaemonClient(defaultPtyHostSocketPath())
  try {
    await client.connect()
    return await client.request("pty.list", {})
  } catch {
    return { sessions: [] }
  } finally {
    client.close()
  }
}
