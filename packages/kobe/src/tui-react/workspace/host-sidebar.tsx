/** @jsxImportSource @opentui/react */
/**
 * The workspace host's left rail — which sidebar renders, and its wiring.
 *
 * Extracted from `host.tsx` (file-size cap) when the tree sidebar arrived:
 * two mounts with ~30 shared props each does not fit in a file that was
 * already at the limit. It also isolates the choice — one `mode` prop
 * decides, and everything below it is the same host callbacks either way.
 */

import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import type { Task } from "@/types/task"
import { useCallback } from "react"
import type { TaskSortMode } from "../../tui/panes/sidebar/groups"
import type { SidebarNav } from "../../tui/panes/sidebar/nav-core"
import type { WorktreeChanges } from "../../tui/panes/sidebar/worktree-changes"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { Sidebar, type SidebarHover } from "../panes/sidebar/Sidebar"
import { SidebarTree } from "../panes/sidebar/SidebarTree"
import { closeTaskTab } from "./terminal-tabs-close"

export interface HostSidebarProps {
  /** `tree` = project → worktree → tab; `flat` = the two-section task list. */
  readonly mode: "tree" | "flat"
  readonly width: number
  readonly nav: SidebarNav
  readonly onNavChange: (nav: SidebarNav) => void
  readonly tasks: readonly Task[]
  readonly selectedId: string | null
  readonly selectedTabId: string | null
  readonly onSelect: (taskId: string) => void
  readonly onActivate: (taskId: string) => void
  readonly onSelectTab: (taskId: string, tabId: string) => void
  readonly focused: boolean
  readonly engineState?: ReadonlyMap<string, TaskEngineState>
  readonly engineLifecycle?: ReadonlyMap<string, { readonly subagents: number }>
  readonly taskJobs?: ReadonlyMap<string, TaskJobState>
  readonly worktreeChanges?: ReadonlyMap<string, WorktreeChanges> | null
  readonly transcriptActivity?: ReadonlyMap<string, { readonly mtimeMs: number }> | null
  readonly onHoverChange: (hover: SidebarHover | null) => void
  readonly hoverEnabled: boolean
  readonly onAddTask: () => void
  readonly onDeleteRequest: (taskId: string) => void
  readonly onArchiveRequest: (taskId: string) => void
  readonly onRenameRequest: (taskId: string) => void
  readonly onPinRequest: (taskId: string) => void
  readonly moveMode: boolean
  readonly onMoveRequest: (taskId: string, delta: -1 | 1) => void
  readonly onMoveModeExit: () => void
  readonly onLocalMergeRequest: (taskId: string) => void
  readonly sortMode: TaskSortMode
  readonly onSortModeToggle: () => void
  readonly projectFilter: string | null
  readonly onProjectFilterChange: (repo: string | null) => void
  readonly onSearchActiveChange: (active: boolean) => void
  readonly headerStatus: { label: string; emphasize: boolean }
  readonly onHeaderStatusClick: () => void
  readonly zenActive: boolean
  readonly onZenClick: () => void
  readonly onFocusRequest: () => void
}

export function HostSidebar(props: HostSidebarProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const notif = useNotifications()
  const t = useT()
  // Tab close is the one sidebar action the host can't express as a task-level
  // callback: the tree names a tab of ANY worktree, so who owns that tab's
  // state depends on whether its TerminalTabs is mounted. `closeTaskTab` is
  // where that fork lives; a refusal (the task's last tab) surfaces as a toast
  // rather than a silent no-op.
  const closeTab = useCallback(
    (taskId: string, tabId: string): void => {
      if (!closeTaskTab(kv, taskId, tabId))
        notif.notify({ kind: "error", taskId, tabId, title: t("terminal.tab.cannotCloseLast") })
    },
    [kv, notif, t],
  )
  // Shared by both mounts. Split out so the two JSX blocks can't drift on
  // the props they DO have in common.
  const common = {
    width: props.width,
    nav: props.nav,
    onNavChange: props.onNavChange,
    tasks: props.tasks,
    selectedId: props.selectedId,
    onSelect: props.onSelect,
    onActivate: props.onActivate,
    engineState: props.engineState,
    engineLifecycle: props.engineLifecycle,
    taskJobs: props.taskJobs,
    worktreeChanges: props.worktreeChanges,
    transcriptActivity: props.transcriptActivity,
    focused: props.focused,
    onDeleteRequest: props.onDeleteRequest,
    onArchiveRequest: props.onArchiveRequest,
    onRenameRequest: props.onRenameRequest,
    onPinRequest: props.onPinRequest,
    onLocalMergeRequest: props.onLocalMergeRequest,
    // Move mode and the search-active signal are BOTH sidebars' business.
    // They used to sit only on the flat branch, which silently made the
    // tree's move mode dead on arrival — the same way the brand header went
    // missing when it was passed to one mount and not the other.
    moveMode: props.moveMode,
    onMoveRequest: props.onMoveRequest,
    onMoveModeExit: props.onMoveModeExit,
    onSearchActiveChange: props.onSearchActiveChange,
    onAddTask: props.onAddTask,
    headerStatus: props.headerStatus,
    onHeaderStatusClick: props.onHeaderStatusClick,
    zenActive: props.zenActive,
    onZenClick: props.onZenClick,
  }
  return (
    <box width={props.width} flexShrink={0} backgroundColor={theme.backgroundPanel} onMouseUp={props.onFocusRequest}>
      {props.mode === "tree" ? (
        <SidebarTree
          {...common}
          selectedTabId={props.selectedTabId}
          onSelectTab={props.onSelectTab}
          onCloseTab={closeTab}
        />
      ) : (
        <Sidebar
          {...common}
          onHoverChange={props.onHoverChange}
          hoverEnabled={props.hoverEnabled}
          // Flat-only: the tree replaces sorting with its own structure and
          // the project filter with fold-the-others (docs/KEYBINDINGS.md).
          sortMode={props.sortMode}
          onSortModeToggle={props.onSortModeToggle}
          projectFilter={props.projectFilter}
          onProjectFilterChange={props.onProjectFilterChange}
        />
      )}
    </box>
  )
}
