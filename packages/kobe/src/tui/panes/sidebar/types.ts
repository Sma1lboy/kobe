import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import type { Task } from "@/types/task"
import type { WorktreeChanges } from "./worktree-changes"

/** Reactive getter — `SidebarProps` is a Solid-era shape; `() => T` matches `Accessor<T>`. */
type Accessor<T> = () => T

/**
 * Legacy chat-run-state shape kept as an inert type so older callers don't
 * break their imports. Always-empty in v0.6; row liveness now primarily comes
 * from daemon engine activity.
 */
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
  /** Fires on keyboard enter, and optionally mouse click in the Tasks pane. */
  onActivate?: (taskId: string) => void
  /** Task pane opts in because click-to-switch is cheap there. */
  activateOnClick?: boolean
  /** Keep a task-bound pane visually pinned to its own task after jump-away. */
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
  /**
   * Optional width override. When omitted, falls back to the default sidebar
   * rail width.
   */
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
  /**
   * Parent-level overlay hook for native workspace. When omitted, Sidebar
   * renders its own local fallback tooltip for standalone/tmux pane hosts.
   */
  onHoverChange?: (hover: SidebarHover | null) => void
}
