import type { Task } from "../../types/task.ts"

export function activeTaskSessionId(task: Task | undefined, activeChatTabId: string | null | undefined): string | null {
  if (!task) return null
  const tabId = activeChatTabId ?? task.activeTabId
  return task.tabs.find((tab) => tab.id === tabId)?.sessionId ?? null
}
