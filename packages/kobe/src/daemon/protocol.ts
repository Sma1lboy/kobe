/**
 * Daemon wire protocol (v0.6).
 *
 * v0.5's protocol was huge because the daemon hosted live chat
 * streams: `chat.delta`, `chat.event`, `chat.complete`, pending-input
 * brokers, plan-usage polling, rc-bridge state, etc. v0.6 collapses
 * all of that — claude lives in tmux, so the daemon's only job is to
 * be a single writer for the task index. The protocol shrinks to a
 * task-CRUD + subscribe shape.
 */

import type { Task } from "../types/task.ts"

/**
 * Bumped to 2 in v0.6 to signal the shape change. Older TUI clients
 * that hello with version 1 are rejected by the server with a clear
 * "daemon is v0.6, upgrade your TUI" error.
 */
export const DAEMON_PROTOCOL_VERSION = 2

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
  | "task.delete"
  | "task.pin"
  | "task.status"
  | "task.ensureMain"
  | "task.ensureWorktree"

export type DaemonEventName = "task.created" | "task.updated" | "task.deleted" | "task.snapshot" | "daemon.stopping"

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
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function frameToLine(frame: DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}
