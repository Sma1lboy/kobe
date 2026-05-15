/**
 * Lifecycle + handshake commands.
 *
 *   - `hello`        : enriched handshake that returns tasks, pending
 *                      input, per-tab run state, plan usage, and rcBridge
 *                      status in one round-trip
 *   - `daemon.status`: pid + uptime + attached client count
 *   - `daemon.stop`  : graceful shutdown
 */

import type { DaemonContext, DaemonHandler } from "../context.ts"
import { DAEMON_PROTOCOL_VERSION, serializeTask } from "../protocol.ts"

const hello: DaemonHandler = async (_req, client, ctx) => {
  // Enrich the handshake so a fresh attach only needs `hello`
  // then `subscribe` instead of `hello` → `task.list` → N×
  // `chat.input.pending` round-trips. Old clients ignore the
  // extra fields; the legacy `task.list` and `chat.input.pending`
  // request handlers remain in place for backwards compat.
  const tasks = ctx.orch.listTasks()
  const pending: Record<string, ReturnType<typeof ctx.orch.peekPendingInput>> = {}
  for (const task of tasks) {
    const entries = ctx.orch.peekPendingInput(task.id)
    if (entries.length > 0) pending[task.id] = entries
  }
  // Snapshot per-tab run state so a reconnecting TUI repaints
  // the green/yellow status dot on already-streaming tabs
  // immediately — without this the indicator disappears until
  // the next chat.delta / engine.status / chat.event arrives.
  const runState: Record<string, string> = {}
  for (const [key, value] of ctx.orch.chatRunStateSignal()()) runState[key] = value
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    daemonPid: process.pid,
    clientId: client.id,
    tasks: tasks.map(serializeTask),
    pending,
    runState,
    planUsage: ctx.planUsagePoller.current(),
    rcBridge: ctx.rcBridge.status(),
  }
}

const daemonStatus: DaemonHandler = async (_req, _client, ctx: DaemonContext) => {
  return {
    daemonPid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt.getTime(),
    startedAt: ctx.startedAt.toISOString(),
    attachedClients: ctx.clients.size,
    taskCount: ctx.orch.listTasks().length,
    socketPath: ctx.socketPath,
  }
}

const daemonStop: DaemonHandler = async (_req, _client, ctx) => {
  await ctx.stopSoon()
  return {}
}

export const lifecycleHandlers: Record<string, DaemonHandler> = {
  hello,
  "daemon.status": daemonStatus,
  "daemon.stop": daemonStop,
}
