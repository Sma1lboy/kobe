import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import type { Task } from "@/types/task"
import type { TaskSortMode } from "../../../tui/panes/sidebar/groups"
import type { ChatRunState, SidebarHover } from "../../../tui/panes/sidebar/types"
import type { WorktreeChanges } from "../../../tui/panes/sidebar/worktree-changes"

export type { ChatRunState, SidebarHover } from "../../../tui/panes/sidebar/types"

export type SidebarProps = {
  tasks: readonly Task[]
  selectedId: string | null
  onSelect: (id: string) => void
  onActivate?: (taskId: string) => void
  activateOnClick?: boolean
  pinnedSelection?: boolean
  focused?: boolean
  onDeleteRequest?: (taskId: string) => void
  onArchiveRequest?: (taskId: string) => void
  onLocalMergeRequest?: (taskId: string) => void
  moveMode?: boolean
  onMoveRequest?: (taskId: string, delta: -1 | 1) => void
  onMoveModeExit?: () => void
  onRenameRequest?: (taskId: string) => void
  onPinRequest?: (taskId: string) => void
  onPreviewToggleRequest?: (taskId: string) => void
  sortMode?: TaskSortMode
  onSortModeToggle?: () => void
  projectFilter?: string | null
  onProjectFilterChange?: (repo: string | null) => void
  onSearchActiveChange?: (active: boolean) => void
  onCursorChange?: (taskId: string | null) => void
  width?: number
  headerStatus?: { label: string; emphasize: boolean } | null
  onHeaderStatusClick?: () => void
  onAddTask?: () => void
  zenActive?: boolean
  onZenClick?: () => void
  chatRunState?: ReadonlyMap<string, ChatRunState>
  engineState?: ReadonlyMap<string, TaskEngineState>
  taskJobs?: ReadonlyMap<string, TaskJobState>
  worktreeChanges?: ReadonlyMap<string, WorktreeChanges> | null
  onHoverChange?: (hover: SidebarHover | null) => void
}
