/**
 * Cross-task attention wiring for the native workspace host (P0):
 *
 *  1. Rising-edge notify — diff the previous vs current daemon `engineState`
 *     map each render and fire `notify()` for any NON-selected task that just
 *     crossed into an attention state (permission_needed / error / turn_complete).
 *     The selected task already surfaces its own state in the middle column, so
 *     it's skipped. Gated by the `notifications.crossTask.enabled` preference.
 *  2. Jump-to-next — the return value `jumpToNextAttention()` is the handler
 *     the global chord binds to; it walks the sidebar order to the next task
 *     needing input/attention and selects it (or toasts when none).
 *
 * State is engine-owned and vendor-neutral: `TaskEngineState.state` and the
 * unread map are the only inputs, so there are no Claude/Codex strings here.
 * The two pure helpers (`attentionKindFor`, `nextAttentionTask`) live in the
 * framework-free `tui/lib/notify-state`.
 */

import { useEffect, useRef } from "react"
import type { TaskEngineState } from "../../client/remote-orchestrator"
import { attentionKindFor, nextAttentionTask } from "../../tui/lib/notify-state"
import type { Task } from "../../types/task"
import type { KVContext } from "../context/kv"
import type { NotificationsContext } from "../context/notifications"

const CROSS_TASK_KEY = "notifications.crossTask.enabled"

export function useAttention(args: {
  tasks: readonly Task[]
  engineState: ReadonlyMap<string, TaskEngineState>
  selectedId: string | null
  kv: KVContext
  notif: NotificationsContext
  selectTask: (id: string) => void
  focusWorkspace: () => void
  /** i18n'd toast shown when the chord finds no waiting task. */
  noTasksMessage: string
}): { jumpToNextAttention: () => void } {
  const { tasks, engineState, selectedId, kv, notif, selectTask, focusWorkspace, noTasksMessage } = args

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
    const target = nextAttentionTask(order, engineState, notif.unread, selectedId)
    if (!target) {
      notif.notify({ kind: "done", taskId: selectedId ?? "", tabId: "", title: noTasksMessage })
      return
    }
    selectTask(target)
    focusWorkspace()
  }

  return { jumpToNextAttention }
}
