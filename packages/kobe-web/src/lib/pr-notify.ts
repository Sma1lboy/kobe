/**
 * PR status transitions worth pinging about — CI flipping red/green, a PR
 * becoming ready to merge, a merge landing — derived by diffing consecutive
 * task.snapshot payloads. Pure + React-free; the store calls prTransitions
 * from its snapshot reducer and hands the results to notify.ts.
 *
 * Blast guards: only tasks present in BOTH snapshots are diffed (a page-load
 * hydration has no prev, so nothing fires), and both sides must already have
 * a PR (a PR's first appearance is not a transition).
 */

import type { Task, TaskPRStatus } from "./types.ts"

export type PrTransitionKind =
  | "merged"
  | "ready_to_merge"
  | "checks_failing"
  | "checks_passing"

export interface PrTransition {
  taskId: string
  /** Card/notification label — title falling back like the rest of the UI. */
  taskLabel: string
  kind: PrTransitionKind
  number?: number
}

/** Check-state edges only matter while the PR is still actionable. */
function checksApply(lifecycle: TaskPRStatus["lifecycle"]): boolean {
  return lifecycle === "open" || lifecycle === "ready_to_merge"
}

/**
 * The single most meaningful rising edge between two PR statuses, or null.
 * Lifecycle edges (merged, ready to merge) outrank check edges; a repeat of
 * the same state never fires.
 */
export function prTransition(
  prev: TaskPRStatus | undefined,
  next: TaskPRStatus | undefined,
): PrTransitionKind | null {
  if (!prev || !next) return null
  if (next.lifecycle === "merged")
    return prev.lifecycle !== "merged" ? "merged" : null
  if (
    next.lifecycle === "ready_to_merge" &&
    prev.lifecycle !== "ready_to_merge"
  )
    return "ready_to_merge"
  if (!checksApply(next.lifecycle)) return null
  if (next.checkState === "failing" && prev.checkState !== "failing")
    return "checks_failing"
  if (next.checkState === "passing" && prev.checkState !== "passing")
    return "checks_passing"
  return null
}

/** Diff two task snapshots into the PR transitions to announce. */
export function prTransitions(
  prevTasks: readonly Task[],
  nextTasks: readonly Task[],
): PrTransition[] {
  const prevById = new Map(prevTasks.map((t) => [t.id, t]))
  const out: PrTransition[] = []
  for (const task of nextTasks) {
    const prev = prevById.get(task.id)
    if (!prev) continue
    const kind = prTransition(prev.prStatus, task.prStatus)
    if (!kind) continue
    out.push({
      taskId: task.id,
      taskLabel: task.title || task.branch || task.id,
      kind,
      ...(task.prStatus?.number !== undefined
        ? { number: task.prStatus.number }
        : {}),
    })
  }
  return out
}

/** Notification body line per transition kind. */
export function prTransitionBody(t: PrTransition): string {
  const pr = t.number !== undefined ? `PR #${t.number}` : "PR"
  switch (t.kind) {
    case "merged":
      return `${pr} merged.`
    case "ready_to_merge":
      return `${pr} is ready to merge.`
    case "checks_failing":
      return `${pr} checks failing.`
    case "checks_passing":
      return `${pr} checks passing.`
  }
}
