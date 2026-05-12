/**
 * Watches the orchestrator's per-tab run-state signal and fires a
 * notification each time a background chat-tab transitions out of
 * `running` — either into `awaiting_input` (yellow toast) or to idle
 * (green toast, "done").
 *
 * Visibility gate: a transition for the currently-visible (task, tab) is
 * never notified — the user is watching it happen in real time. The
 * unread map is also skipped, so just looking at a tab while it finishes
 * doesn't paint a dot the user then has to manually clear.
 */

import { type Accessor, createEffect } from "solid-js"
import { type ChatRunState, chatRunStateKey } from "../../orchestrator/core"
import type { Task } from "../../types/task"
import type { NotificationsContext } from "../context/notifications"

export interface CompletionNotificationsDeps {
  chatRunState: Accessor<ReadonlyMap<string, ChatRunState>>
  tasks: Accessor<readonly Task[]>
  /**
   * The `${taskId}:${tabId}` currently visible to the user, or null
   * when no chat tab is on screen (file tab open, no task selected,
   * etc.). Used to suppress notifications for in-view transitions.
   */
  visibleTabKey: Accessor<string | null>
  notifications: NotificationsContext
}

function tabLabel(tasks: readonly Task[], taskId: string, tabId: string): string {
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return "chat tab"
  const tab = task.tabs.find((t) => t.id === tabId)
  const tabName = tab?.title && tab.title.length > 0 ? tab.title : tab ? `chat ${tab.seq}` : "chat"
  return `${task.title} › ${tabName}`
}

export function useCompletionNotifications(deps: CompletionNotificationsDeps): void {
  // Seed `prev` to the current map so the first effect tick doesn't
  // mis-fire on the seed value. Solid runs effects after mount with the
  // initial signal value, but we compare prev→curr and ignore
  // already-idle keys, so a same-value first tick is a no-op anyway.
  let prev: ReadonlyMap<string, ChatRunState> = new Map()

  createEffect(() => {
    const curr = deps.chatRunState()
    const visible = deps.visibleTabKey()
    const tasks = deps.tasks()

    for (const [key, state] of prev) {
      const next = curr.get(key)
      // running → awaiting_input: tab paused waiting for the user.
      if (state === "running" && next === "awaiting_input") {
        if (key === visible) continue
        const [taskId, tabId] = splitKey(key)
        if (!taskId || !tabId) continue
        deps.notifications.notify({
          kind: "needs_input",
          taskId,
          tabId,
          title: tabLabel(tasks, taskId, tabId),
        })
        continue
      }
      // running | awaiting_input → idle: tab finished its turn.
      if ((state === "running" || state === "awaiting_input") && next === undefined) {
        if (key === visible) continue
        const [taskId, tabId] = splitKey(key)
        if (!taskId || !tabId) continue
        deps.notifications.notify({
          kind: "done",
          taskId,
          tabId,
          title: tabLabel(tasks, taskId, tabId),
        })
      }
    }
    prev = curr
  })
}

/**
 * Inverse of {@link chatRunStateKey}. Returns `[taskId, tabId]` or
 * `[null, null]` when the key shape is unexpected (defensive — every
 * key currently in the map should already be in shape).
 */
function splitKey(key: string): readonly [string | null, string | null] {
  const idx = key.indexOf(":")
  if (idx < 0) return [null, null]
  return [key.slice(0, idx), key.slice(idx + 1)]
}

// Re-export so callers building the visibleTabKey accessor don't need a
// second import path.
export { chatRunStateKey }
