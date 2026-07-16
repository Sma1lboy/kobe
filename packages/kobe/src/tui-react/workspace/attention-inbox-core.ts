import { attentionInboxItemKey } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { AttentionInboxItem } from "../../client/remote-orchestrator"
import type { Task } from "../../types/task"

export const attentionInboxKey = attentionInboxItemKey

export function attentionInboxCounts(items: readonly AttentionInboxItem[]): { total: number } {
  return { total: items.length }
}

export function isAttentionInboxItemAvailable(
  item: AttentionInboxItem,
  task: Pick<Task, "archived"> | undefined,
  hasTab: (tabId: string) => boolean,
): boolean {
  return task !== undefined && !task.archived && (item.tabId === null || hasTab(item.tabId))
}

/**
 * Oldest first — the Inbox is a queue that drains top-down (opening an
 * episode removes it; a fresh event re-records at the latest position).
 * Task order breaks same-instant ties for stability.
 */
export function sortAttentionInbox(
  items: readonly AttentionInboxItem[],
  taskOrder: readonly string[],
): AttentionInboxItem[] {
  const taskIndex = new Map(taskOrder.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const age = a.at - b.at
    if (age !== 0) return age
    const task =
      (taskIndex.get(a.taskId) ?? Number.MAX_SAFE_INTEGER) - (taskIndex.get(b.taskId) ?? Number.MAX_SAFE_INTEGER)
    if (task !== 0) return task
    return attentionInboxItemKey(a).localeCompare(attentionInboxItemKey(b))
  })
}

/**
 * Pick the next pending episode (oldest first). Unavailable episodes stay in
 * the Inbox dialog but are excluded from F7.
 */
export function nextAttentionInboxTarget(
  items: readonly AttentionInboxItem[],
  taskOrder: readonly string[],
  current: { taskId: string | null; tabId: string | null },
  isAvailable: (item: AttentionInboxItem) => boolean = () => true,
): AttentionInboxItem | null {
  const liveTasks = new Set(taskOrder)
  const ordered = sortAttentionInbox(items, taskOrder).filter((item) => liveTasks.has(item.taskId) && isAvailable(item))
  if (ordered.length === 0) return null
  const currentKey = current.taskId === null ? null : attentionInboxItemKey(current)
  const currentIndex =
    currentKey === null ? -1 : ordered.findIndex((item) => attentionInboxItemKey(item) === currentKey)
  if (currentIndex < 0) return ordered[0] ?? null
  // The sole pending episode may already be the current tab. Returning it
  // lets F7 resolve it instead of leaving an unvisitable item stuck.
  if (ordered.length === 1) return ordered[0] ?? null
  return ordered[(currentIndex + 1) % ordered.length] ?? null
}
