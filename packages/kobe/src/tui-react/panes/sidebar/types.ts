/**
 * React sidebar prop types (issue #15, G3). Same surface as the Solid
 * `src/tui/panes/sidebar/types.ts`, with the idiomatic React translation:
 * every `Accessor<T>` prop becomes a plain `T` — the host re-renders the
 * Sidebar when the value changes, so per-read reactivity has no equivalent.
 * Callback props are unchanged. Shared data shapes (`SidebarHover`,
 * `ChatRunState`, `WorktreeChanges`) are the framework-free originals.
 */

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
  /** Fires on keyboard enter, and optionally mouse click in the Tasks pane. */
  onActivate?: (taskId: string) => void
  /** Task pane opts in because click-to-switch is cheap there. */
  activateOnClick?: boolean
  /** Keep a task-bound pane visually pinned to its own task after jump-away. */
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
  /** Presence (non-undefined) turns on the sort toggle, like the Solid accessor. */
  sortMode?: TaskSortMode
  onSortModeToggle?: () => void
  /** Presence (non-undefined, null = "all") makes the filter host-controlled. */
  projectFilter?: string | null
  onProjectFilterChange?: (repo: string | null) => void
  onSearchActiveChange?: (active: boolean) => void
  onCursorChange?: (taskId: string | null) => void
  /** Optional width override; defaults to the sidebar rail width. */
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
  /**
   * Parent-level overlay hook for native workspace. When omitted, Sidebar
   * renders its own local fallback tooltip for standalone/tmux pane hosts.
   */
  onHoverChange?: (hover: SidebarHover | null) => void
}
