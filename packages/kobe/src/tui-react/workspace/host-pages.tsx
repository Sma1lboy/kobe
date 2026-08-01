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

import { type ReactNode, useState } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { type SidebarNav, focusPaneForNav } from "../../tui/panes/sidebar/nav-core"
import type { Task } from "../../types/task"
import { AutomationsPage } from "../component/automations-page"
import { KanbanPage } from "../component/kanban-page"
import { UpdatePage } from "../component/update-page"
import { WorkItemsPage } from "../component/work-items-page"
import { WorktreesPage } from "../component/worktrees-page"
import type { FocusContextValue } from "../context/focus"

export interface HostPageState {
  readonly worktreesOpen: boolean
  readonly automationsOpen: boolean
  readonly workItemsOpen: boolean
  readonly kanbanOpen: boolean
  readonly updateOpen: boolean
}

export interface HostPagesState extends HostPageState {
  readonly nav: SidebarNav
  /** Point the rail without moving focus — task selection uses this. */
  readonly setNav: (next: SidebarNav) => void
  readonly goToNav: (next: SidebarNav) => void
  readonly settingsOpen: boolean
  readonly openSettings: () => void
  readonly closeSettings: () => void
  readonly openWorktrees: () => void
  readonly closeWorktrees: () => void
  readonly openUpdate: () => void
  readonly closeUpdate: () => void
  readonly openKanban: () => void
  readonly closeKanban: () => void
  readonly openAutomations: () => void
  readonly closeAutomations: () => void
  readonly openWorkItems: () => void
  readonly closeWorkItems: () => void
}

/**
 * Which surface the workspace shows — extracted from `host.tsx` (file-size
 * cap) into the module that renders those surfaces.
 *
 * Settings / Worktrees / Update are full swaps with their own booleans. The
 * rail's pages (kanban/automations/issues) are ONE `nav` value — three
 * independent booleans allowed "kanban and automations both open", a state
 * the rail cannot represent and no key can reach.
 *
 * Opening a rail page moves focus INTO the content pane (`goToNav`), and
 * leaving hands it back. Without this the page renders but its keys stay
 * dead — they are gated on the content pane being focused, so `n` fell
 * through to the sidebar's new-task chord while the Automations page sat
 * there telling the user to press `n`.
 */
export function useHostPagesState(focus: FocusContextValue): HostPagesState {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [worktreesOpen, setWorktreesOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [nav, setNav] = useState<SidebarNav>("terminal")
  const goToNav = (next: SidebarNav): void => {
    setNav(next)
    focus.setFocused(focusPaneForNav(next))
  }
  return {
    nav,
    setNav,
    goToNav,
    settingsOpen,
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
    worktreesOpen,
    openWorktrees: () => setWorktreesOpen(true),
    closeWorktrees: () => setWorktreesOpen(false),
    updateOpen,
    openUpdate: () => setUpdateOpen(true),
    closeUpdate: () => setUpdateOpen(false),
    kanbanOpen: nav === "kanban",
    openKanban: () => goToNav("kanban"),
    closeKanban: () => goToNav("terminal"),
    automationsOpen: nav === "automations",
    openAutomations: () => goToNav("automations"),
    closeAutomations: () => goToNav("terminal"),
    workItemsOpen: nav === "issues",
    openWorkItems: () => goToNav("issues"),
    closeWorkItems: () => goToNav("terminal"),
  }
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
  /** True while the content pane holds focus — rail pages share the window
   *  with the sidebar, so their bare keys are gated on it. */
  readonly contentFocused: boolean
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
        focused={deps.contentFocused}
        {...(deps.selectedTask ? { focusRepo: deps.selectedTask.repo } : {})}
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
        focused={deps.contentFocused}
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
        focused={deps.contentFocused}
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
