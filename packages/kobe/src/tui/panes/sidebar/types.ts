import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import type { Task } from "@/types/task"
import type { Accessor } from "solid-js"
import type { WorktreeChanges } from "./worktree-changes"

export type ChatRunState = "running" | "awaiting_input" | "idle"

export type SidebarHover = {
  readonly task: Task
  readonly x: number
  readonly y: number
}

export type SidebarProps = {
  tasks: Accessor<readonly Task[]>
  selectedId: Accessor<string | null>
  onSelect: (id: string) => void
  onActivate?: (taskId: string) => void
  activateOnClick?: boolean
  pinnedSelection?: boolean
  focused?: Accessor<boolean>
  onDeleteRequest?: (taskId: string) => void
  onArchiveRequest?: (taskId: string) => void
  onLocalMergeRequest?: (taskId: string) => void
  moveMode?: Accessor<boolean>
  onMoveRequest?: (taskId: string, delta: -1 | 1) => void
  onMoveModeExit?: () => void
  onRenameRequest?: (taskId: string) => void
  onPinRequest?: (taskId: string) => void
  onPreviewToggleRequest?: (taskId: string) => void
  sortMode?: Accessor<"default" | "recent">
  onSortModeToggle?: () => void
  projectFilter?: Accessor<string | null>
  onProjectFilterChange?: (repo: string | null) => void
  onSearchActiveChange?: (active: boolean) => void
  onCursorChange?: (taskId: string | null) => void
  width?: Accessor<number>
  headerStatus?: Accessor<{ label: string; emphasize: boolean } | null>
  onHeaderStatusClick?: () => void
  onAddTask?: () => void
  zenActive?: Accessor<boolean>
  onZenClick?: () => void
  chatRunState?: Accessor<ReadonlyMap<string, ChatRunState>>
  engineState?: Accessor<ReadonlyMap<string, TaskEngineState>>
  taskJobs?: Accessor<ReadonlyMap<string, TaskJobState>>
  worktreeChanges?: Accessor<ReadonlyMap<string, WorktreeChanges> | null>
  onHoverChange?: (hover: SidebarHover | null) => void
}
