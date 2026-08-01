/** @jsxImportSource @opentui/react */
/**
 * The workspace host's full-page swaps, in one place.
 *
 * Each of these replaces the whole workspace rather than layering over it, so
 * they were a run of early-returns at the top of `host.tsx`'s render. Six of
 * them is enough to be its own thing — and `host.tsx` is at the repo's file
 * size cap, so a seventh has to land here rather than there.
 *
 * Order is the precedence order: the first open page wins. That matters only
 * in theory (the keybinding gate stops a second page opening over a first),
 * but keeping it explicit means a future page can't silently shadow one.
 */

import type { ReactNode } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import type { Task } from "../../types/task"
import { AutomationsPage } from "../component/automations-page"
import { KanbanPage } from "../component/kanban-page"
import { UpdatePage } from "../component/update-page"
import { WorkItemsPage } from "../component/work-items-page"
import { WorktreesPage } from "../component/worktrees-page"

export interface HostPageState {
  readonly worktreesOpen: boolean
  readonly automationsOpen: boolean
  readonly workItemsOpen: boolean
  readonly kanbanOpen: boolean
  readonly updateOpen: boolean
}

export interface HostPageDeps extends HostPageState {
  readonly orchestrator: RemoteOrchestrator | null
  readonly selectedTask: Task | undefined
  readonly closeWorktrees: () => void
  readonly closeAutomations: () => void
  readonly closeWorkItems: () => void
  readonly closeKanban: () => void
  readonly closeUpdate: () => void
  readonly activateTask: (taskId: string) => void
  readonly startIssueChat: Parameters<typeof KanbanPage>[0]["onStartChat"]
  readonly engineStates: Parameters<typeof KanbanPage>[0]["engineStates"]
}

/**
 * FULL-WINDOW pages — Worktrees and Update replace everything, sidebar
 * included. They are reached by their own chords, not by the rail, and have
 * no task list to stay beside.
 */
export function renderFullWindowPage(deps: HostPageDeps): ReactNode | null {
  if (deps.worktreesOpen) {
    return <WorktreesPage orchestrator={deps.orchestrator} onClose={deps.closeWorktrees} />
  }
  if (deps.updateOpen) {
    return <UpdatePage onClose={deps.closeUpdate} />
  }
  return null
}

/**
 * CONTENT-PANE pages — what the sidebar rail swaps. The task list stays
 * visible beside these, which is how selecting a task returns to its
 * terminal.
 */
export function renderContentPage(deps: HostPageDeps): ReactNode | null {
  const orch = deps.orchestrator

  if (deps.automationsOpen) {
    return (
      <AutomationsPage
        orchestrator={orch}
        onClose={deps.closeAutomations}
        onOpenTask={(taskId) => {
          deps.closeAutomations()
          deps.activateTask(taskId)
        }}
      />
    )
  }

  if (deps.workItemsOpen) {
    return (
      <WorkItemsPage
        orchestrator={orch}
        onClose={deps.closeWorkItems}
        // Opens pointed at the selected task's project, the same way the
        // kanban does — the page you wanted is almost always this one's.
        {...(deps.selectedTask ? { focusRepo: deps.selectedTask.repo } : {})}
        onOpenTask={(taskId) => {
          deps.closeWorkItems()
          deps.activateTask(taskId)
        }}
      />
    )
  }

  if (deps.kanbanOpen) {
    return (
      <KanbanPage
        orchestrator={orch}
        onClose={deps.closeKanban}
        onStartChat={deps.startIssueChat}
        engineStates={deps.engineStates}
        // `c` fires from the sidebar, so the board opens pointed at the
        // SELECTED task's project + its linked story card.
        focusTask={deps.selectedTask ? { id: deps.selectedTask.id, repo: deps.selectedTask.repo } : undefined}
        onOpenTask={(taskId) => {
          deps.closeKanban()
          deps.activateTask(taskId)
        }}
      />
    )
  }

  return null
}
