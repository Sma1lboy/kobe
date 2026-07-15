import type { AttentionInboxItem } from "../../client/remote-orchestrator"
import type { Task } from "../../types/task"

const STATE_PRIORITY: Record<AttentionInboxItem["state"], number> = {
  permission_needed: 0,
  error: 1,
  rate_limited: 1,
  turn_complete: 2,
}

export function attentionInboxKey(item: { taskId: string | null; tabId: string | null }): string {
  return `${item.taskId}\u0000${item.tabId ?? ""}`
}

export function isAttentionInboxItemAvailable(
  item: AttentionInboxItem,
  task: Pick<Task, "archived"> | undefined,
  hasTab: (tabId: string) => boolean,
): boolean {
  return task !== undefined && !task.archived && (item.tabId === null || hasTab(item.tabId))
}

/** Actionable states first, then oldest episode, with task order as a stable tie-breaker. */
export function sortAttentionInbox(
  items: readonly AttentionInboxItem[],
  taskOrder: readonly string[],
): AttentionInboxItem[] {
  const taskIndex = new Map(taskOrder.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const priority = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state]
    if (priority !== 0) return priority
    const age = a.at - b.at
    if (age !== 0) return age
    const task =
      (taskIndex.get(a.taskId) ?? Number.MAX_SAFE_INTEGER) - (taskIndex.get(b.taskId) ?? Number.MAX_SAFE_INTEGER)
    if (task !== 0) return task
    return attentionInboxKey(a).localeCompare(attentionInboxKey(b))
  })
}

/**
 * Pick the next retained episode without consuming it. Items for tasks that
 * are no longer jumpable stay in the Inbox UI but are excluded from F7.
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
  const currentKey = current.taskId === null ? null : attentionInboxKey(current)
  const currentIndex = currentKey === null ? -1 : ordered.findIndex((item) => attentionInboxKey(item) === currentKey)
  if (currentIndex < 0) return ordered[0] ?? null
  if (ordered.length === 1) return null
  return ordered[(currentIndex + 1) % ordered.length] ?? null
}
