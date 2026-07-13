/**
 * Workspace task selection — extracted verbatim from WorkspaceRoot
 * (file-size cap split): the selected-task state, the adopt-first-focus
 * rule, the archived/deleted-task PTY sweep, and the select/activate
 * actions. The framework-free activation policy stays in
 * use-task-selection.ts; this hook owns only the React reactivity.
 */

import { useEffect, useRef, useState } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import type { Task } from "../../types/task.ts"
import { activateWorkspaceTask, firstSelectableTask } from "./use-task-selection"

export interface WorkspaceSelection {
  readonly selectedId: string | null
  readonly setSelectedId: (id: string | null) => void
  readonly selectedTask: Task | undefined
  /** Click/cursor selection — publishes the shared active-task focus. */
  readonly selectTask: (id: string) => void
  /** Enter/double-click activation — materializes the worktree if needed. */
  readonly activateTask: (id: string) => Promise<void>
}

export function useWorkspaceSelection(args: {
  readonly orch: RemoteOrchestrator
  readonly tasks: readonly Task[]
  readonly activeTaskId: string | null
  readonly focusWorkspace: () => void
}): WorkspaceSelection {
  const { orch, tasks, activeTaskId } = args
  const [selectedId, setSelectedId] = useState<string | null>(() => orch.activeTaskSignal()())

  const focusRestoredRef = useRef(false)
  const userPickedRef = useRef(false)
  // Adopt the daemon's first restored focus, but never let later events from
  // sibling clients yank a task the local user already selected.
  useEffect(() => {
    if (!focusRestoredRef.current && activeTaskId && tasks.some((task) => task.id === activeTaskId)) {
      focusRestoredRef.current = true
      if (!userPickedRef.current && selectedId !== activeTaskId) {
        setSelectedId(activeTaskId)
        return
      }
    }
    if (selectedId && tasks.some((task) => task.id === selectedId)) return
    setSelectedId(firstSelectableTask(tasks, activeTaskId)?.id ?? null)
  }, [tasks, activeTaskId, selectedId])

  // PTY lifecycle (issue #16): archiving/deleting a task must end every
  // engine session it owns — its tab PTYs are keyed `taskId::tabId` in the
  // default registry, invisible to the pane once unmounted. Watch the task
  // snapshot and release the corpses; the pane never kills (registry docs),
  // so this is the one place tab shells die with their task.
  const liveTaskIdsRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const next = new Set<string>(tasks.filter((task) => !task.archived).map((task) => task.id))
    const registry = getDefaultPtyRegistry()
    for (const id of liveTaskIdsRef.current) {
      if (!next.has(id)) registry.releaseWhere((key) => key === id || key.startsWith(`${id}::`))
    }
    liveTaskIdsRef.current = next
  }, [tasks])

  function selectTask(id: string): void {
    userPickedRef.current = true
    if (selectedId === id) return
    setSelectedId(id)
    void orch.setActiveTask(id).catch((error) => console.error("[kobe workspace] setActiveTask failed:", error))
  }

  // Last-intent-wins: a slow activation that resolves after a newer one must
  // not yank selection/focus back to the older task.
  const activationGenerationRef = useRef(0)
  async function activateTask(id: string): Promise<void> {
    const generation = ++activationGenerationRef.current
    await activateWorkspaceTask(
      {
        getTask: (taskId) => tasks.find((task) => task.id === taskId),
        ensureWorktree: (taskId) => orch.ensureWorktree(taskId),
        selectTask,
        focusWorkspace: args.focusWorkspace,
        reportError: (error) => console.error("[kobe workspace] task.ensureWorktree failed:", error),
        isCurrent: () => activationGenerationRef.current === generation,
      },
      id,
    )
  }

  const selectedTask = selectedId ? tasks.find((task) => task.id === selectedId) : undefined
  return { selectedId, setSelectedId, selectedTask, selectTask, activateTask }
}
