import type { EngineActivityDetail, TaskActivityState } from "@/engine/hook-events"
import type { Task } from "@/types/task"
import type { UpdateInfo } from "@/version"
import type { RepoIssues } from "./issues-store.ts"

export const DAEMON_PROTOCOL_VERSION = 3

export const MIN_COMPATIBLE_PROTOCOL_VERSION = 2

export function isProtocolCompatible(args: {
  readonly localVersion: number
  readonly localMin: number
  readonly remoteVersion: number
  readonly remoteMin: number
}): boolean {
  return args.remoteVersion >= args.localMin && args.localVersion >= args.remoteMin
}

export function isDaemonVersionStale(daemonVersion: string | undefined, clientVersion: string): boolean {
  if (!daemonVersion) return false
  return daemonVersion !== clientVersion
}

export type DaemonFrame =
  | { readonly type: "request"; readonly id: string; readonly name: DaemonRequestName; readonly payload?: unknown }
  | {
      readonly type: "response"
      readonly id: string
      readonly name?: string
      readonly payload?: unknown
      readonly error?: DaemonError
    }
  | { readonly type: "event"; readonly name: DaemonEventName; readonly payload: unknown }

export type DaemonRequestName =
  | "hello"
  | "daemon.status"
  | "daemon.stop"
  | "subscribe"
  | "task.list"
  | "task.get"
  | "task.create"
  | "task.archive"
  | "task.rename"
  | "task.setBranch"
  | "task.setVendor"
  | "task.delete"
  | "task.pin"
  | "task.move"
  | "task.status"
  | "task.reorder"
  | "task.ensureMain"
  | "project.forget"
  | "task.ensureWorktree"
  | "task.setActive"
  | "issue.list"
  | "issue.mutate"
  | "worktree.discoverAdoptable"
  | "worktree.adopt"
  | "worktree.reconcile"
  | "worktree.archiveRemoved"
  | "worktree.list"
  | "worktree.remove"
  | "engine.reportEvent"
  | "session.deliver"
  | "note.file"

export type SubscribeRole = "gui" | "pane"

export interface ChannelPayloads {
  "task.snapshot": { tasks: SerializedTask[] }
  "issue.snapshot": RepoIssues
  "active-task": { taskId: string | null }
  update: { info: UpdateInfo | null }
  "engine-state": { taskId: string; state: TaskActivityState; detail?: EngineActivityDetail; at: number }
  "ui-prefs": {
    theme: string
    transparentBackground: boolean
    focusAccent: string | null
    locale: string
    sortMode: "default" | "recent"
    keysCollapsed: boolean
    projectFilter: string | null
  }
  keybindings: { rev: number }
  "task.jobs": {
    taskId: string
    kind: "ensureWorktree"
    phase: "running" | "done" | "error"
    error?: string
  }
  "worktree.changes": {
    changes: Record<string, { added: number; deleted: number }>
  }
  "transcript.activity": {
    activity: Record<string, { mtimeMs: number; completionId: string | null; completionAt: number }>
  }
  "session.deliver": SessionDeliverPayload
}

export interface SessionDeliverPayload {
  readonly taskId: string
  readonly text: string
  readonly at: number
  readonly source: "note" | "dispatcher"
}

export type UiPrefsPayload = ChannelPayloads["ui-prefs"]

export type WorktreeChangesPayload = ChannelPayloads["worktree.changes"]

export type TranscriptActivityPayload = ChannelPayloads["transcript.activity"]

export type ChannelName = keyof ChannelPayloads

export const CHANNEL_NAMES: readonly ChannelName[] = [
  "task.snapshot",
  "issue.snapshot",
  "active-task",
  "update",
  "engine-state",
  "ui-prefs",
  "keybindings",
  "task.jobs",
  "worktree.changes",
  "transcript.activity",
  "session.deliver",
]

const CHANNEL_NAME_SET: ReadonlySet<string> = new Set<string>(CHANNEL_NAMES)

export function isChannelName(value: unknown): value is ChannelName {
  return typeof value === "string" && CHANNEL_NAME_SET.has(value)
}

export function normalizeChannelFilter(value: unknown): ReadonlySet<ChannelName> | null {
  if (!Array.isArray(value)) return null
  const set = new Set<ChannelName>()
  for (const name of value) if (isChannelName(name)) set.add(name)
  return set.size > 0 ? set : null
}

export type DaemonEventName = ChannelName | "daemon.stopping"

export interface DaemonError {
  readonly message: string
  readonly name?: string
}

export interface SerializedTask {
  readonly id: string
  readonly title: string
  readonly repo: string
  readonly branch: string
  readonly worktreePath: string
  readonly kind: "main" | "task"
  readonly status: Task["status"]
  readonly archived: boolean
  readonly pinned: boolean
  readonly vendor?: Task["vendor"]
  readonly prStatus?: Task["prStatus"]
  readonly position?: number
  readonly modelEffort?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export function serializeTask(task: Task): SerializedTask {
  return {
    id: task.id,
    title: task.title,
    repo: task.repo,
    branch: task.branch,
    worktreePath: task.worktreePath,
    kind: task.kind ?? "task",
    status: task.status,
    archived: task.archived,
    pinned: task.pinned ?? false,
    vendor: task.vendor,
    prStatus: task.prStatus,
    position: task.position,
    modelEffort: task.modelEffort,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function frameToLine(frame: DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}
