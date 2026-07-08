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
