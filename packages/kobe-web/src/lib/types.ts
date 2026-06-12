/**
 * Browser-side mirrors of the daemon's wire types. Defined locally (not
 * imported from the kobe package) so no server code leaks into the client
 * bundle — these must stay in sync with
 * packages/kobe-daemon/src/daemon/protocol.ts (SerializedTask + ChannelPayloads).
 */

export type TaskKind = "main" | "task"
export type TaskStatus = string
export type Vendor = string | undefined

/** Mirror of the daemon's TaskPRStatus (types/task.ts) — only the fields
 *  the web rail renders are typed; the rest pass through untouched. */
export interface TaskPRStatus {
  provider?: string
  lifecycle?:
    | "creating"
    | "open"
    | "ready_to_merge"
    | "merged"
    | "closed"
    | "unknown"
  checkState?: "none" | "pending" | "passing" | "failing" | "unknown"
  number?: number
  url?: string
}

export interface Task {
  id: string
  title: string
  repo: string
  branch: string
  worktreePath: string
  kind: TaskKind
  status: TaskStatus
  archived: boolean
  pinned: boolean
  vendor?: Vendor
  prStatus?: TaskPRStatus
  /** Web-board ordering key (sparse fractional; absent until first drop). */
  position?: number
  createdAt: string
  updatedAt: string
}

/** Transient engine activity (what the agent is doing right now). */
export type ActivityState =
  | "idle"
  | "running"
  | "waiting_permission"
  | "rate_limited"
  | "error"
  | string

export interface EngineState {
  taskId: string
  state: ActivityState
  detail?: unknown
  at: number
}

export interface UpdateInfo {
  latest?: string
  current?: string
  [k: string]: unknown
}

/** Lifecycle progress of a minute-class daemon job on one task
 *  (today: `task.ensureWorktree` materializing a worktree). */
export interface TaskJob {
  taskId: string
  kind: string
  phase: "running" | "done" | "error"
  error?: string
}

/** worktreePath → uncommitted change counts (daemon-collected). */
export type WorktreeChangeCounts = Record<
  string,
  { added: number; deleted: number }
>

/** The user's persisted visual prefs, fanned out by the daemon's
 *  state.json watcher (mirror of the `ui-prefs` channel payload). */
export interface UiPrefs {
  theme: string
  transparentBackground: boolean
  focusAccent: string | null
  sortMode: "default" | "recent"
  keysCollapsed: boolean
}

/** Channel push, as the bridge serializes it over SSE. */
export type BridgeEvent =
  | { channel: "task.snapshot"; payload: { tasks: Task[] } }
  | { channel: "active-task"; payload: { taskId: string | null } }
  | { channel: "engine-state"; payload: EngineState }
  | { channel: "update"; payload: { info: UpdateInfo | null } }
  | { channel: "task.jobs"; payload: TaskJob }
  | { channel: "worktree.changes"; payload: { changes: WorktreeChangeCounts } }
  | { channel: "ui-prefs"; payload: UiPrefs }

/** Full bootstrap state the bridge sends on connect. */
export interface BridgeSnapshot {
  tasks: Task[]
  activeTaskId: string | null
  engineStates: Record<string, EngineState>
  update: UpdateInfo | null
  /** taskId → in-flight job (running only; bridge drops terminal phases). */
  jobs?: Record<string, TaskJob>
  worktreeChanges?: WorktreeChangeCounts
  uiPrefs?: UiPrefs | null
  connected: boolean
}
