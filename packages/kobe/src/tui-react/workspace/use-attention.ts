/**
 * Cross-task attention wiring for the native workspace host (P0):
 *
 *  1. Rising-edge notify — diff the previous vs current daemon `engineState`
 *     map each render and fire `notify()` for any NON-selected task that just
 *     crossed into an attention state (permission_needed / error / turn_complete).
 *     The selected task already surfaces its own state in the middle column, so
 *     it's skipped. Gated by the `notifications.crossTask.enabled` preference.
 *  2. Jump-to-next — F7 walks the daemon-owned durable Inbox. Jumping never
 *     consumes an episode; removal comes from same-tab turn-start, explicit
 *     episode deletion, or explicit hard-delete of the containing task.
 *
 * State is engine-owned and vendor-neutral: `TaskEngineState.state` and the
 * Inbox state are the only inputs, so there are no Claude/Codex strings here.
 */

import { useEffect, useRef } from "react"
import type { AttentionInboxItem, TaskEngineState } from "../../client/remote-orchestrator"
import { attentionKindFor } from "../../tui/lib/notify-state"
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
  /** i18n'd toast shown when the chord finds no waiting task. */
  noTasksMessage: string
}): { jumpToNextAttention: () => void } {
  const { tasks, engineState, inboxItems, selectedId, kv, notif, openAttention, noTasksMessage } = args

  // Previous frame's per-task state, for rising-edge detection. Seeded on the
  // first render so tasks already sitting in an attention state at mount don't
  // fire a burst of stale notifications.
  const prevStates = useRef<Map<string, string> | null>(null)

  useEffect(() => {
    const prev = prevStates.current
    const next = new Map<string, string>()
    for (const [id, es] of engineState) next.set(id, es.state)

    if (prev && kv.get(CROSS_TASK_KEY, true) !== false) {
      for (const [id, state] of next) {
        if (id === selectedId) continue // the selected task shows its own state
        if (prev.get(id) === state) continue // no transition
        const kind = attentionKindFor(state)
        if (!kind) continue
        const title = tasks.find((t) => t.id === id)?.title ?? id
        notif.notify({ kind, taskId: id, tabId: "", title })
      }
    }
    prevStates.current = next
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
