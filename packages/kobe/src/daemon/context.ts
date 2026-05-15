/**
 * Shared types + the request-context shape every daemon handler receives.
 *
 * Lifted out of `server.ts` so the per-category handler modules under
 * `handlers/` can `import type` what they need without a circular hop
 * through the file that owns the socket lifecycle.
 *
 * `DaemonContext` is built once at daemon startup (`startDaemonServer`)
 * and re-used for every request — handlers don't capture
 * `startDaemonServer`'s closure directly, they take what they need from
 * `ctx` parameters.
 */

import type { Socket } from "node:net"
import type { Orchestrator } from "../orchestrator/core.ts"
import type { Task } from "../types/task.ts"
import type { PlanUsagePoller } from "./plan-usage-poller.ts"
import type { DaemonFrame } from "./protocol.ts"
import type { RcBridge } from "./rc-bridge.ts"

export interface DaemonClientConnection {
  readonly id: number
  readonly connectedAt: Date
}

/**
 * In-memory state per attached client. `subscriptions` keys are
 * `${taskId}:${tabId}` so re-subscribing the same tab is a no-op
 * (prevents the chat.tab.create dupe-subscribe leak — see #3).
 */
export type ClientState = DaemonClientConnection & {
  socket: Socket
  buffer: string
  subscriptions: Map<string, () => void>
}

/**
 * The context every handler receives. Has the long-lived orchestrator,
 * the live set of attached clients, the two background workers
 * (plan-usage poller + remote-control bridge), the daemon's own
 * lifecycle metadata, and pre-bound closures for broadcast /
 * subscription mutations.
 *
 * Handlers must not mutate `clients` directly — use the helpers.
 */
export interface DaemonContext {
  readonly orch: Orchestrator
  readonly clients: ReadonlySet<ClientState>
  readonly planUsagePoller: PlanUsagePoller
  readonly rcBridge: RcBridge
  readonly socketPath: string
  readonly startedAt: Date
  readonly stopSoon: () => Promise<void>
  readonly broadcast: (frame: DaemonFrame) => void
  readonly broadcastTaskUpdated: (taskId: string) => void
  readonly subscribeClientToTask: (client: ClientState, task: Task) => void
  readonly subscribeClientToTab: (client: ClientState, taskId: string, tabId: string) => void
  readonly unsubscribeClientFromTask: (client: ClientState, taskId: string) => void
}

/**
 * Signature for one command handler. Each handlers/*.ts file exports a
 * `Record<string, DaemonHandler>` whose keys are the wire command names
 * the file owns.
 */
export type DaemonHandler = (
  req: Extract<DaemonFrame, { type: "request" }>,
  client: ClientState,
  ctx: DaemonContext,
) => Promise<unknown>
