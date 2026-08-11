/**
 * Cross-task attention wiring for the native workspace host (P0):
 *
 *  1. Rising-edge notify — diff the previous vs current daemon activity each
 *     render and fire `notify()` for any NON-selected task that just crossed
 *     into an attention state (permission_needed / error / rate_limited /
 *     turn_complete — the daemon's `ATTENTION_INBOX_STATES`).
 *     The selected task already surfaces its own state in the middle column, so
 *     it's skipped. Gated by the `notifications.crossTask.enabled` preference.
 *
 *     The diff runs over the PER-TAB map, not the task-level one. The task
 *     entry is a last-event-wins rollup across every tab, and an edge only
 *     fires on a value CHANGE — so two tabs of one task finishing in a row
 *     left the rollup sitting at `turn_complete` and the second one never
 *     announced itself. Two agents finished, you heard about one. The daemon
 *     already keys its Inbox episodes `(taskId, tabId)`, so F7 was right the
 *     whole time; only the toast was lossy. Tasks whose engine reports no tab
 *     identity at all (a `claude` typed into a plain shell — no KOBE_TAB_ID)
 *     have no per-tab entry, so they keep notifying off the rollup.
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
import { tabTitleStable } from "../../tui/workspace/terminal-tabs-core"
import { DEFAULT_TASK_VENDOR, type Task } from "../../types/task"
import type { KVContext } from "../context/kv"
import type { NotificationsContext } from "../context/notifications"
import { isAttentionInboxItemAvailable, nextAttentionInboxTarget } from "./attention-inbox-core"
import { activeTabIdFor, knownTaskTab } from "./terminal-tabs-shared"

const CROSS_TASK_KEY = "notifications.crossTask.enabled"

/** Edge-detection key for one notify target — a tab, or a whole task when
 *  its engine reports no tab identity. Mirrors `unreadKey`'s shape. */
function notifyTargetKey(taskId: string, tabId: string): string {
  return `${taskId}:${tabId}`
}

export type NotifyTarget = { readonly taskId: string; readonly tabId: string }

/**
 * Flatten the daemon's two activity levels into ONE entry per notify target.
 *
 * A task whose tabs report gets one entry per tab; a task whose engine reports
 * no tab identity (a `claude` typed into a plain shell — no `KOBE_TAB_ID`)
 * keeps its task-level rollup entry. Never both: the rollup mirrors whichever
 * tab moved last, so emitting it alongside the tabs double-counts.
 *
 * Pure, so the edge behaviour that actually broke — two tabs of one task
 * finishing in a row — is testable without mounting the host.
 */
export function notifyTargetStates(
  engineState: ReadonlyMap<string, TaskEngineState>,
  engineTabState?: ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>>,
): { states: Map<string, string>; targets: Map<string, NotifyTarget> } {
  const states = new Map<string, string>()
  const targets = new Map<string, NotifyTarget>()
  for (const [taskId, es] of engineState) {
    const tabs = engineTabState?.get(taskId)
    if (tabs && tabs.size > 0) {
      for (const [tabId, tabEs] of tabs) {
        const key = notifyTargetKey(taskId, tabId)
        states.set(key, tabEs.state)
        targets.set(key, { taskId, tabId })
      }
      continue
    }
    const key = notifyTargetKey(taskId, "")
    states.set(key, es.state)
    targets.set(key, { taskId, tabId: "" })
  }
  return { states, targets }
}

export function useAttention(args: {
  tasks: readonly Task[]
  engineState: ReadonlyMap<string, TaskEngineState>
  /** Per-tab activity, `taskId → tabId → state`. Absent for engines that
   *  report no tab identity; those fall back to the task-level rollup. */
  engineTabState?: ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>>
  inboxItems: readonly AttentionInboxItem[]
  selectedId: string | null
  kv: KVContext
  notif: NotificationsContext
  openAttention: (item: AttentionInboxItem) => void
  /** i18n'd toast shown when the chord finds no available Inbox item. */
  noTasksMessage: string
}): { jumpToNextAttention: () => void } {
  const { tasks, engineState, engineTabState, inboxItems, selectedId, kv, notif, openAttention, noTasksMessage } = args

  // Previous frame's state per NOTIFY TARGET, for rising-edge detection.
  // Seeded on the first render so targets already sitting in an attention
  // state at mount don't fire a burst of stale notifications.
  const prevStates = useRef<Map<string, string> | null>(null)

  useEffect(() => {
    const { states: next, targets } = notifyTargetStates(engineState, engineTabState)

    // Edge detection is the shared framework-free `attentionEdges` (the ONE
    // notification module): seed rule inside (prev===null → no toasts). The
    // selected task is filtered AFTER the diff rather than via `skip`, which
    // takes one key: every tab of the selected task has to be excluded (its
    // state is already on the middle column, and its background tabs belong
    // to the per-tab notifier in `use-tab-turn-state`). Dropping those keys
    // from `next` instead would make them read as fresh edges the moment you
    // switched away — a burst of stale toasts on every task switch.
    const edges = attentionEdges(prevStates.current, next, null, attentionKindFor)
    prevStates.current = next
    if (kv.get(CROSS_TASK_KEY, true) === false) return
    const repos = [...new Set(tasks.map((t) => t.repo))]
    for (const { key, kind } of edges) {
      const target = targets.get(key)
      if (!target || target.taskId === selectedId) continue
      const task = tasks.find((t) => t.id === target.taskId)
      // Toast identity mirrors the Inbox card: task title leads, project
      // (repo label) is the context body line — plus the tab when one is
      // known, so two tabs of one task finishing don't read identically.
      const project = task ? sidebarProjectLabel(task.repo, repos) : ""
      const tab = target.tabId ? knownTaskTab(kv, target.taskId, target.tabId) : undefined
      const tabLabel = tab ? tabTitleStable(tab, task?.vendor ?? DEFAULT_TASK_VENDOR) : ""
      notif.notify({
        kind,
        taskId: target.taskId,
        tabId: target.tabId,
        title: task?.title ?? target.taskId,
        body: tabLabel ? `${project} › ${tabLabel}` : project || undefined,
      })
    }
  }, [engineState, engineTabState, selectedId, tasks, kv, notif])

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
