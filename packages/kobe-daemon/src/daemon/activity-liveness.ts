/**
 * Liveness probe for the activity lapse watchdog: resolve taskId → worktree +
 * vendor, then read the engine's transcript for the two facts the watchdog
 * needs (`activity-registry.ts` → `stillWorking`).
 *
 * Split out of `server.ts` (which is at its size cap and is otherwise pure
 * wiring) because this is a real policy decision, not a construction step:
 *
 * - `mtimeMs` answers "is anything still being written". Alone it is NOT
 *   enough — an engine parked at its prompt keeps touching its transcript, so
 *   a missed Stop hook re-armed the watchdog forever and the sidebar spinner
 *   never stopped.
 * - `completedAt` is the newest turn-COMPLETION marker, which answers the
 *   question actually being asked: did this turn already end?
 *
 * Finding the completion already walks the transcript dir and stats its files,
 * so `latestActivity()` yields both from ONE scan — no extra IO versus the
 * mtime-only probe it replaces. Vendors with no completion markers keep the
 * plain mtime heartbeat; there is no "turn ended" fact to read for them.
 *
 * Best-effort by contract: the caller treats a throw as "silent" ⇒ lapse.
 */

import type { ActivityLiveness } from "./activity-registry.ts"
import type { VendorId } from "./contracts.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

/** The slice of the orchestrator this probe reads. */
export interface LivenessTaskLookup {
  getTask(taskId: string): { worktreePath?: string; vendor?: VendorId } | undefined
}

export type LivenessRuntime = Pick<
  DaemonRuntimeAdapter,
  "createEngineTurnDetector" | "latestTranscriptMtime" | "defaultTaskVendor"
>

export async function readActivityLiveness(
  orch: LivenessTaskLookup,
  runtime: LivenessRuntime,
  taskId: string,
  reportedVendor?: string,
): Promise<ActivityLiveness | undefined> {
  const task = orch.getTask(taskId)
  if (!task?.worktreePath) return undefined
  // The hook's own `--engine` tag outranks the task's configured vendor: a
  // custom wrapper id (`claudecpa` → cc-switch → claude) has no transcript
  // store of its own, so probing by task.vendor read mtime 0 and lapsed
  // every long turn to idle mid-work.
  const vendor = (reportedVendor as VendorId | undefined) ?? task.vendor ?? runtime.defaultTaskVendor
  const detector = runtime.createEngineTurnDetector(vendor)
  if (!detector?.supportsCompletionMarkers()) {
    const mtimeMs = await runtime.latestTranscriptMtime(vendor, task.worktreePath)
    return mtimeMs > 0 ? { mtimeMs } : {}
  }
  const { marker, mtimeMs } = await detector.latestActivity(task.worktreePath)
  return {
    ...(mtimeMs > 0 ? { mtimeMs } : {}),
    ...(marker ? { completedAt: marker.timestampMs } : {}),
  }
}
