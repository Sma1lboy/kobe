import { rpc } from "./store.ts"

export type ActiveTaskId = string | null

export function setActiveTask(taskId: ActiveTaskId): Promise<void> {
  return rpc("task.setActive", { taskId })
}

export function setActiveTaskBestEffort(
  taskId: ActiveTaskId,
  onError?: (err: unknown) => void,
): void {
  void setActiveTask(taskId).catch((err) => {
    onError?.(err)
  })
}
