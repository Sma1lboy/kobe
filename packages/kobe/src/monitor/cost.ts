/**
 * Per-task cost aggregation for the monitor's cost dashboard (KOB-230).
 *
 * Vendor-neutral: the actual transcript parsing lives behind the engine
 * registry's `summarizeCost` entry (claude's is
 * `engine/claude-code-local/cost.ts`; the directory-layout knowledge
 * stays in that vendor's `history.ts`). This module only does the
 * monitor-specific part: resolve the task's engine entry and wrap its
 * worktree summary with task identity.
 *
 * Only claude has a wired cost reader today — codex/copilot/custom
 * entries carry `summarizeCost: null`, so their tasks summarize to
 * zeros. Plumbing codex (KOB-232) is one registry entry, no change here.
 */

import { engineEntry } from "@/engine/registry"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"

export interface TaskCostSummary {
  readonly taskId: string
  readonly worktree: string
  readonly sessionCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreateTokens: number
  readonly lastActivityMs: number | null
}

/**
 * Sum engine usage across every session transcript in the worktree.
 * Returns zeros (`sessionCount: 0`) when the task was never entered or
 * the vendor has no cost reader. `vendor` defaults to claude — the
 * pre-registry behavior (the dashboard was claude-only and callers
 * don't pass a vendor yet).
 */
export async function summarizeTaskCost(opts: {
  taskId: string
  worktree: string
  vendor?: VendorId
}): Promise<TaskCostSummary> {
  const entry = engineEntry(opts.vendor ?? DEFAULT_TASK_VENDOR)
  const zero: TaskCostSummary = {
    taskId: opts.taskId,
    worktree: opts.worktree,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    lastActivityMs: null,
  }
  if (!entry.summarizeCost) return zero
  const summary = await entry.summarizeCost(opts.worktree)
  return { taskId: opts.taskId, worktree: opts.worktree, ...summary }
}
