/**
 * Cross-task attention wiring for the native workspace host (P0):
 *
 *  1. Rising-edge notify — diff the previous vs current daemon `engineState`
 *     map each render and fire `notify()` for any NON-selected task that just
 *     crossed into an attention state (permission_needed / error / turn_complete).
 *     The selected task already surfaces its own state in the middle column, so
 *     it's skipped. Gated by the `notifications.crossTask.enabled` preference.
 *  2. Jump-to-next — the return value `jumpToNextAttention()` is the handler
 *     the global chord binds to; it walks (task, tab) candidates in sidebar
 *     order × tab order — waiting/question/error/turn-complete, including the
 *     other tabs of the CURRENT task — selects the task, activates the tab,
 *     and marks it read so the cycle advances (or toasts when none).
 *
 * State is engine-owned and vendor-neutral: `TaskEngineState.state` and the
 * unread map are the only inputs, so there are no Claude/Codex strings here.
 * The two pure helpers (`attentionKindFor`, `nextAttentionTarget`) live in the
 * framework-free `tui/lib/notify-state`.
 */

import { useEffect, useRef } from "react"
import type { EngineTabStateMap, TaskEngineState } from "../../client/remote-orchestrator"
import { attentionKindFor, nextAttentionTarget } from "../../tui/lib/notify-state"
import type { Task } from "../../types/task"
import type { KVContext } from "../context/kv"
import type { NotificationsContext } from "../context/notifications"
import { activeTabIdFor, requestTabActivation } from "./terminal-tabs-shared"

const CROSS_TASK_KEY = "notifications.crossTask.enabled"

export function useAttention(args: {
  tasks: readonly Task[]
  engineState: ReadonlyMap<string, TaskEngineState>
  engineTabStates: EngineTabStateMap
  selectedId: string | null
  kv: KVContext
  notif: NotificationsContext
  selectTask: (id: string) => void
  focusWorkspace: () => void
  /** i18n'd toast shown when the chord finds no waiting task. */
  noTasksMessage: string
}): { jumpToNextAttention: () => void } {
  const { tasks, engineState, engineTabStates, selectedId, kv, notif, selectTask, focusWorkspace, noTasksMessage } =
    args

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
    const target = nextAttentionTarget(order, engineState, engineTabStates, notif.unread, {
      taskId: selectedId,
      tabId: selectedId ? activeTabIdFor(selectedId) : null,
    })
    if (!target) {
      notif.notify({ kind: "done", taskId: selectedId ?? "", tabId: "", title: noTasksMessage })
      return
    }
    // Arrival = seen: clear the unread marks that made this target a
    // candidate so the next press ADVANCES instead of revisiting a seen
    // completion. Blocking raw states (permission/error) persist by design.
    notif.markRead(target.taskId, "")
    if (target.tabId) notif.markRead(target.taskId, target.tabId)
    selectTask(target.taskId)
    if (target.tabId) requestTabActivation(target.taskId, target.tabId)
    focusWorkspace()
  }

  return { jumpToNextAttention }
}
