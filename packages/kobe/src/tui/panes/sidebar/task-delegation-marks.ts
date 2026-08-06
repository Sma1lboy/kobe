/** Pure sidebar projection of durable primary -> subagent Task links. */

import type { Task } from "../../../types/task.ts"

export interface TaskDelegationMarks {
  readonly isSubagent: boolean
  readonly subagentCount: number
}

/**
 * Index both sides of the directed link without storing mirrored topology.
 * A Task can carry both marks when explicitly used in a delegation chain.
 */
export function indexTaskDelegationMarks(tasks: readonly Task[]): ReadonlyMap<string, TaskDelegationMarks> {
  const mutable = new Map<string, { isSubagent: boolean; subagentCount: number }>()
  const marksFor = (taskId: string) => {
    const existing = mutable.get(taskId)
    if (existing) return existing
    const created = { isSubagent: false, subagentCount: 0 }
    mutable.set(taskId, created)
    return created
  }

  for (const task of tasks) {
    if (!task.delegation) continue
    marksFor(String(task.id)).isSubagent = true
    marksFor(task.delegation.primaryTaskId).subagentCount += 1
  }
  return mutable
}

/** Keep the existing sidebar title budget honest when persistent marks render. */
export function delegationTitleBudget(base: number, marks: TaskDelegationMarks | undefined): number {
  const prefixCells = marks?.isSubagent ? 1 : 0
  const countCells = marks && marks.subagentCount > 0 ? String(marks.subagentCount).length + 3 : 0
  return Math.max(6, base - prefixCells - countCells)
}
