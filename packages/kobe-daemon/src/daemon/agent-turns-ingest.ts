/**
 * Turn-telemetry ingest (issue #32): the bridge from an engine hook report to
 * the durable {@link AgentTurnsStore}.
 *
 * Fired on `turn-complete`, the one event that means "a turn just finished and
 * its records are on disk". Everything here is best-effort and fire-and-forget
 * — the hook RPC must not wait on a transcript read, and a telemetry failure
 * must never surface to the engine.
 *
 * The vendor read is delegated to the runtime adapter (`readEngineTurns`), so
 * the daemon stays vendor-blind: it supplies a path and an engine id, and the
 * engine's own adapter decides what a turn is.
 */

import type { AgentTurnsStore } from "./agent-turns-store.ts"
import type { AgentTurnRecord, DaemonOrchestrator, VendorId } from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

export interface TurnIngestInput {
  readonly taskId: string
  readonly tabId?: string
  /** The `--engine` tag the hook carried; falls back to the task's vendor. */
  readonly vendor?: string
  /** The engine's own transcript, from its hook payload. No path = nothing to read. */
  readonly transcriptPath?: string
}

/**
 * Read the finished turns out of `transcriptPath` and merge them into the
 * store, joined to the task's identity. Resolves to the number of NEW turns
 * (0 when the transcript held nothing unseen, which is the common case since
 * every read starts from the top of the file).
 */
export async function ingestAgentTurns(
  store: AgentTurnsStore,
  runtime: DaemonRuntimeAdapter,
  orch: DaemonOrchestrator,
  input: TurnIngestInput,
): Promise<number> {
  if (!input.transcriptPath) return 0
  const task = orch.getTask(input.taskId)
  const vendor = (input.vendor ?? task?.vendor) as VendorId | undefined
  if (!vendor) return 0
  const turns = await runtime.readEngineTurns(vendor, input.transcriptPath)
  if (turns.length === 0) return 0
  const records: AgentTurnRecord[] = turns.map((turn) => ({
    ...turn,
    taskId: input.taskId,
    ...(input.tabId ? { tabId: input.tabId } : {}),
    vendor,
    ...(task?.repo ? { repo: task.repo } : {}),
  }))
  return await store.record(records)
}

/** Fire-and-forget wrapper for the hook path: never throws, never awaited. */
export function ingestAgentTurnsBestEffort(
  store: AgentTurnsStore | undefined,
  runtime: DaemonRuntimeAdapter,
  orch: DaemonOrchestrator,
  input: TurnIngestInput,
): void {
  if (!store) return
  void ingestAgentTurns(store, runtime, orch, input).catch((err) => logDaemonError("agent-turns-ingest", err))
}
