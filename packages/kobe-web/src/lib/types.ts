export type TaskKind = "main" | "task"
export type TaskStatus = string
export type Vendor = string | undefined

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
  position?: number
  modelEffort?: string
  createdAt: string
  updatedAt: string
}

export type IssueStatus = "open" | "doing" | "hold" | "done"

export interface Issue {
  id: number
  title: string
  status: IssueStatus
  created: string
  body: string
  taskId?: string
}

export interface RepoIssues {
  repoRoot: string
  exists: boolean
  nextId: number
  issues: Issue[]
}

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

export interface TaskJob {
  taskId: string
  kind: string
  phase: "running" | "done" | "error"
  error?: string
}

export type WorktreeChangeCounts = Record<
  string,
  { added: number; deleted: number }
>

export interface SessionDeliver {
  taskId: string
  text: string
  at: number
  source: "note" | "dispatcher"
}

export interface UiPrefs {
  theme: string
  transparentBackground: boolean
  focusAccent: string | null
  sortMode: "default" | "recent"
  keysCollapsed: boolean
  projectFilter?: string | null
}

export type WebTransportEvent =
  | { channel: "task.snapshot"; payload: { tasks: Task[] } }
  | { channel: "issue.snapshot"; payload: RepoIssues }
  | { channel: "active-task"; payload: { taskId: string | null } }
  | { channel: "engine-state"; payload: EngineState }
  | { channel: "update"; payload: { info: UpdateInfo | null } }
  | { channel: "task.jobs"; payload: TaskJob }
  | { channel: "worktree.changes"; payload: { changes: WorktreeChangeCounts } }
  | { channel: "session.deliver"; payload: SessionDeliver }
  | { channel: "ui-prefs"; payload: UiPrefs }

export interface WebTransportSnapshot {
  tasks: Task[]
  activeTaskId: string | null
  engineStates: Record<string, EngineState>
  update: UpdateInfo | null
  jobs?: Record<string, TaskJob>
  worktreeChanges?: WorktreeChangeCounts
  issueSnapshots?: Record<string, RepoIssues>
  deliver?: SessionDeliver | null
  uiPrefs?: UiPrefs | null
  connected: boolean
}
