/**
 * Mission-control triage — sort a task into one attention bucket from its
 * transient engine state + worktree dirtiness. Shared so the Overview view and
 * any future cross-task surface bucket identically (the activity.ts precedent).
 *
 * Priority is deliberate and load-bearing: a task that needs a human
 * (waiting_permission / error / rate_limited) outranks everything, then a
 * running task, then an idle-but-dirty task, then quiet (idle + clean). So a
 * running task with a dirty worktree reads as "working", not "changes" — the
 * live action is the more urgent signal than uncommitted files.
 */

import type { EngineState } from "./types.ts"

export type Bucket = "attention" | "working" | "changes" | "quiet"

export function triage(
  engine: EngineState | undefined,
  changes: { added: number; deleted: number } | undefined,
): Bucket {
  const state = engine?.state
  if (
    state === "waiting_permission" ||
    state === "error" ||
    state === "rate_limited"
  ) {
    return "attention"
  }
  if (state === "running") return "working"
  if (changes && (changes.added > 0 || changes.deleted > 0)) return "changes"
  return "quiet"
}
