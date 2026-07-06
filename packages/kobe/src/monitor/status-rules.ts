import { autoStatusEnabled } from "@/state/auto-status"
import type { Task, TaskStatus } from "@/types/task"

export interface StatusRuleOrchestrator {
  getTask(id: string): Task | undefined
  setStatus(id: string, status: TaskStatus): Promise<void>
}

export type AutoStatusResult = "moved" | "skipped"

export async function maybeAutoStart(
  orch: StatusRuleOrchestrator,
  taskId: string,
  enabled: () => boolean = autoStatusEnabled,
): Promise<AutoStatusResult> {
  if (!enabled()) return "skipped"
  const task = orch.getTask(taskId)
  if (!task) return "skipped"
  if ((task.kind ?? "task") === "main" || task.archived) return "skipped"
  if (task.status !== "backlog") return "skipped"
  await orch.setStatus(taskId, "in_progress")
  return "moved"
}
