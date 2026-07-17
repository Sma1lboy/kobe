/**
 * Cross-task attention wiring for the native workspace host (P0):
 *
 *  1. Rising-edge notify — diff the previous vs current daemon `engineState`
 *     map each render and fire `notify()` for any NON-selected task that just
 *     crossed into an attention state (permission_needed / error / rate_limited
 *     / turn_complete — the daemon's `ATTENTION_INBOX_STATES`).
 *     The selected task already surfaces its own state in the middle column, so
 *     it's skipped. Gated by the `notifications.crossTask.enabled` preference.
 *  2. Jump-to-next — F7 walks available pending items in the daemon-owned
 *     durable Inbox. Opening or visiting the target resolves the item and
 *     removes it from the queue.
 *
 * State is engine-owned and vendor-neutral: `TaskEngineState.state` and the
 * Inbox state are the only inputs, so there are no Claude/Codex strings here.
 */

import { useEffect, useRef } from "react"
import type { AttentionInboxItem, TaskEngineState } from "../../client/remote-orchestrator"
import { attentionEdges, attentionKindFor } from "../../tui/lib/notify-state"
import { sidebarProjectLabel } from "../../tui/panes/sidebar/groups"
import type { Task } from "../../types/task"
import type { KVContext } from "../context/kv"
import type { NotificationsContext } from "../context/notifications"
import { isAttentionInboxItemAvailable, nextAttentionInboxTarget } from "./attention-inbox-core"
import { activeTabIdFor, knownTaskTab } from "./terminal-tabs-shared"

const CROSS_TASK_KEY = "notifications.crossTask.enabled"

export function useAttention(args: {
  tasks: readonly Task[]
  engineState: ReadonlyMap<string, TaskEngineState>
  inboxItems: readonly AttentionInboxItem[]
  selectedId: string | null
  kv: KVContext
  notif: NotificationsContext
  openAttention: (item: AttentionInboxItem) => void
  /** i18n'd toast shown when the chord finds no available Inbox item. */
  noTasksMessage: string
}): { jumpToNextAttention: () => void } {
  const { tasks, engineState, inboxItems, selectedId, kv, notif, openAttention, noTasksMessage } = args

  // Previous frame's per-task state, for rising-edge detection. Seeded on the
  // first render so tasks already sitting in an attention state at mount don't
  // fire a burst of stale notifications.
  const prevStates = useRef<Map<string, string> | null>(null)

  useEffect(() => {
    const next = new Map<string, string>()
    for (const [id, es] of engineState) next.set(id, es.state)

    // Edge detection is the shared framework-free `attentionEdges` (the ONE
    // notification module): seed rule inside (prev===null → no toasts), the
    // selected task skipped (its state is already on the middle column).
    const edges = attentionEdges(prevStates.current, next, selectedId, attentionKindFor)
    prevStates.current = next
    if (kv.get(CROSS_TASK_KEY, true) === false) return
    const repos = [...new Set(tasks.map((t) => t.repo))]
    for (const { key: id, kind } of edges) {
      const task = tasks.find((t) => t.id === id)
      // Toast identity mirrors the Inbox card: task title leads, project
      // (repo label) is the context body line.
      notif.notify({
        kind,
        taskId: id,
        tabId: "",
        title: task?.title ?? id,
        body: task ? sidebarProjectLabel(task.repo, repos) : undefined,
      })
    }
  }, [engineState, selectedId, tasks, kv, notif])

  function jumpToNextAttention(): void {
    const order = tasks.filter((t) => !t.archived).map((t) => t.id)
    const target = nextAttentionInboxTarget(
      inboxItems,
      order,
      {
        taskId: selectedId,
        tabId: selectedId ? activeTabIdFor(selectedId) : null,
      },
      (item) =>
        isAttentionInboxItemAvailable(
          item,
          tasks.find((task) => task.id === item.taskId),
          (tabId) => knownTaskTab(kv, item.taskId, tabId) !== undefined,
        ),
    )
    if (!target) {
      notif.notify({ kind: "done", taskId: selectedId ?? "", tabId: "", title: noTasksMessage })
      return
    }
    openAttention(target)
  }

  return { jumpToNextAttention }
}
