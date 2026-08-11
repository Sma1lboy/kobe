import { attentionInboxItemKey } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { AttentionInboxItem } from "../../client/remote-orchestrator"
import { compareRecent } from "../../tui/panes/sidebar/groups"
import type { Task } from "../../types/task"
import { type InboxVisit, inboxVisitIndex } from "./inbox-visits"

export const attentionInboxKey = attentionInboxItemKey

export function attentionInboxCounts(items: readonly AttentionInboxItem[]): { total: number } {
  return { total: items.length }
}

/**
 * Episodes RESOLVED by the user landing on their target: visiting a tab (or
 * selecting a task) means its pending attention was seen — the episode
 * leaves the queue without an explicit open. Tab-scoped episodes match the
 * exact (task, tab); task-level episodes (tabId null) match any visit to
 * the task.
 */
export function visitResolvedEpisodes(
  items: readonly AttentionInboxItem[],
  visit: { taskId: string; tabId: string | null },
): AttentionInboxItem[] {
  return items.filter((item) => item.taskId === visit.taskId && (item.tabId === null || item.tabId === visit.tabId))
}

/**
 * Whether an episode's target still exists.
 *
 * `hasTab` is TRI-STATE, and the distinction is load-bearing: `false` means
 * the tab list was readable and this tab is gone; `undefined` means the tab
 * list could not be read at all (this process has never mounted that task's
 * TerminalTabs, so its KV snapshot is absent). Callers treat unavailable
 * episodes as garbage and DELETE them from the daemon, so answering "gone"
 * for "don't know" destroyed live episodes — the owner-reported "two tabs
 * are unread but the Inbox only lists one" (2026-08-10). Unknown keeps the
 * episode.
 */
export function isAttentionInboxItemAvailable(
  item: AttentionInboxItem,
  task: Pick<Task, "archived"> | undefined,
  hasTab: (tabId: string) => boolean | undefined,
): boolean {
  if (task === undefined || task.archived) return false
  if (item.tabId === null) return true
  return hasTab(item.tabId) !== false
}

export function partitionAttentionInboxAvailability(
  items: readonly AttentionInboxItem[],
  tasks: readonly Pick<Task, "id" | "archived">[],
  hasTab: (taskId: string, tabId: string) => boolean | undefined,
): { availableItems: AttentionInboxItem[]; unavailableItems: AttentionInboxItem[] } {
  const tasksById = new Map<string, Pick<Task, "id" | "archived">>(tasks.map((task) => [task.id, task]))
  const availableItems: AttentionInboxItem[] = []
  const unavailableItems: AttentionInboxItem[] = []
  for (const item of items) {
    const available = isAttentionInboxItemAvailable(item, tasksById.get(item.taskId), (tabId) =>
      hasTab(item.taskId, tabId),
    )
    if (available) availableItems.push(item)
    else unavailableItems.push(item)
  }
  return { availableItems, unavailableItems }
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

/** How many RECENT tasks trail the attention queue. */
export const INBOX_RECENT_LIMIT = 5

export type InboxRow =
  | { readonly kind: "header"; readonly id: string; readonly section: "attention" | "recent" }
  | { readonly kind: "attention"; readonly id: string; readonly item: AttentionInboxItem }
  | {
      readonly kind: "recent"
      readonly id: string
      readonly task: Task
      /** The tab you were last on in this task, when one was recorded. */
      readonly tabId: string | null
      /** Last visit time, or the task's own mtime when never visited. */
      readonly at: number
    }

/**
 * The Inbox reads as ONE list with two sections: every pending episode
 * (unread by definition — opening one removes it) sits on top, oldest
 * first so the queue drains top-down, then the TABS you most recently
 * VISITED. Rows are per (task, tab), matching the visit log and the
 * episode rows above — switching among one task's chat tabs is the most
 * common way to move around, so collapsing them into a single per-task
 * row hid exactly the places you'd want to jump back to.
 *
 * A target with a pending episode is not repeated below (a task-level
 * episode covers every tab of its task); neither is the tab you're on.
 *
 * Visit order comes from the log (`inbox-visits.ts`), not `updatedAt` —
 * "where was I" is not "what changed". Never-visited tasks still appear
 * as one task-level row each, ranked below every visited tab by their own
 * mtime, so a fresh install has a useful RECENT section before the log
 * fills up.
 */
export function inboxRows(
  items: readonly AttentionInboxItem[],
  tasks: readonly Task[],
  options: {
    selectedId?: string | null
    /** The tab you're looking at right now, when the selected task has one. */
    selectedTabId?: string | null
    recentLimit?: number
    visits?: readonly InboxVisit[]
    /**
     * TRI-STATE "does this tab still exist" (see `taskTabExists`). Nothing
     * prunes the visit log when a tab closes, and a row whose tab is gone
     * renders with the TASK's label — so three closed tabs of one task read
     * as three identical rows that each eat a slot and open nothing.
     * `undefined` (unreadable list) KEEPS the row, same rule as episodes.
     */
    tabExists?: (taskId: string, tabId: string) => boolean | undefined
  } = {},
): InboxRow[] {
  const attention = sortAttentionInbox(
    items,
    tasks.map((task) => task.id),
  )
  const tasksById = new Map(tasks.map((task) => [String(task.id), task]))
  // A visited row names one tab, so only an episode on THAT tab (or a
  // task-level one) duplicates it. An unvisited row is task-level, so any
  // episode on its task does.
  const pendingTasks = new Set(items.map((item) => item.taskId))
  const coveredTab = (taskId: string, tabId: string | null): boolean =>
    items.some((item) => item.taskId === taskId && (item.tabId === null || item.tabId === tabId))
  const visited = [...inboxVisitIndex(options.visits ?? []).values()]
  // No known active tab (task never mounted its tabs) falls back to hiding
  // the whole selected task, as before — there's nothing tab-precise to say.
  const isSelected = (taskId: string, tabId: string | null): boolean =>
    taskId === options.selectedId && (options.selectedTabId == null || tabId === options.selectedTabId)
  // A visit to a tab that has since closed opens nothing and renders with the
  // task's own label, so several of them read as duplicate rows. Confirmed
  // gone drops the row; unreadable keeps it.
  const tabAlive = (visit: InboxVisit): boolean =>
    visit.tabId === null || options.tabExists?.(visit.taskId, visit.tabId) !== false
  const visitedRows = visited
    .map((visit) => ({ visit, task: tasksById.get(visit.taskId) }))
    .filter(
      (entry): entry is { visit: InboxVisit; task: Task } =>
        entry.task !== undefined &&
        !entry.task.archived &&
        tabAlive(entry.visit) &&
        !coveredTab(entry.visit.taskId, entry.visit.tabId) &&
        !isSelected(entry.visit.taskId, entry.visit.tabId),
    )
    .map(({ visit, task }) => ({
      kind: "recent" as const,
      id: visit.tabId ? `r:${visit.taskId}:${visit.tabId}` : `r:${visit.taskId}`,
      task,
      tabId: visit.tabId,
      at: visit.at,
    }))
  const seenTasks = new Set(visited.map((visit) => visit.taskId))
  const unvisitedRows = tasks
    .filter(
      (task) =>
        !task.archived && !seenTasks.has(task.id) && !pendingTasks.has(task.id) && task.id !== options.selectedId,
    )
    .sort(compareRecent)
    .map((task) => ({ kind: "recent" as const, id: `r:${task.id}`, task, tabId: null, at: taskMtime(task) }))
  const recent = [...visitedRows, ...unvisitedRows].slice(0, options.recentLimit ?? INBOX_RECENT_LIMIT)
  const rows: InboxRow[] = []
  if (attention.length > 0) {
    rows.push({ kind: "header", id: "header:attention", section: "attention" })
    for (const item of attention) rows.push({ kind: "attention", id: `a:${attentionInboxItemKey(item)}`, item })
  }
  if (recent.length > 0) {
    rows.push({ kind: "header", id: "header:recent", section: "recent" })
    rows.push(...recent)
  }
  return rows
}

function taskMtime(task: Task): number {
  const parsed = Date.parse(task.updatedAt || task.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Cursor movement that steps over section headers, wrapping both ways. */
export function nextSelectableRow(rows: readonly InboxRow[], from: number, delta: 1 | -1): number {
  const total = rows.length
  let index = from
  for (let step = 0; step < total; step++) {
    index = (index + delta + total) % total
    if (rows[index]?.kind !== "header") return index
  }
  return from
}

/** Clamp a stale cursor back onto a selectable row after the list changes. */
export function clampSelectableRow(rows: readonly InboxRow[], cursor: number): number {
  if (rows.length === 0) return 0
  const bounded = Math.min(Math.max(cursor, 0), rows.length - 1)
  return rows[bounded]?.kind === "header" ? nextSelectableRow(rows, bounded, 1) : bounded
}

/**
 * Pick the next pending episode (oldest first). Unavailable episodes are
 * excluded while the Inbox pane's silent cleanup drains them.
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
