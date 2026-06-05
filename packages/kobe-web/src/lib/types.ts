/**
 * Browser-side mirrors of the daemon's wire types. Defined locally (not
 * imported from the kobe package) so no server code leaks into the client
 * bundle — these must stay in sync with
 * packages/kobe-daemon/src/daemon/protocol.ts (SerializedTask + ChannelPayloads).
 */

export type TaskKind = "main" | "task"
export type TaskStatus = string
export type Vendor = string | undefined

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
  prStatus?: unknown
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

/** Channel push, as the bridge serializes it over SSE. */
export type BridgeEvent =
  | { channel: "task.snapshot"; payload: { tasks: Task[] } }
  | { channel: "active-task"; payload: { taskId: string | null } }
  | { channel: "engine-state"; payload: EngineState }
  | { channel: "update"; payload: { info: UpdateInfo | null } }

/** Full bootstrap state the bridge sends on connect. */
export interface BridgeSnapshot {
  tasks: Task[]
  activeTaskId: string | null
  engineStates: Record<string, EngineState>
  update: UpdateInfo | null
  connected: boolean
}
