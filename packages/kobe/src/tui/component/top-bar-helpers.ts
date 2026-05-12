import type { Task } from "../../types/task.ts"

export function formatSessionIdLabel(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  return `sid ${sessionId}`
}

export function activeTaskSessionId(task: Task | undefined, activeChatTabId: string | null | undefined): string | null {
  if (!task) return null
  const tabId = activeChatTabId ?? task.activeTabId
  return task.tabs.find((tab) => tab.id === tabId)?.sessionId ?? task.sessionId ?? null
}
