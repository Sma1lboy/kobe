import type { SessionUsageMetrics } from "../session/usage-metrics.ts"
import type { Message, OrchestratorEvent } from "../types/engine.ts"
import type { Task } from "../types/task.ts"

export const DAEMON_PROTOCOL_VERSION = 1

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
  | "task.spawn"
  | "task.archive"
  | "task.rename"
  | "task.delete"
  | "task.pin"
  | "task.permissionMode"
  | "task.model"
  | "task.ensureMain"
  | "chat.tab.create"
  | "chat.tab.close"
  | "chat.tab.activate"
  | "chat.tab.rename"
  | "chat.tab.clear"
  | "chat.sessions"
  | "chat.session.open"
  | "chat.interrupt"
  | "chat.steer"
  | "chat.input.pending"
  | "chat.input.respond"
  | "merge.local.request"
  | "pr.request"
  | "chat.history"
  | "chat.send"
  | "rcBridge.start"
  | "rcBridge.stop"
  | "rcBridge.status"

export type DaemonEventName =
  | "task.created"
  | "task.updated"
  | "task.deleted"
  | "task.snapshot"
  | "chat.delta"
  | "chat.event"
  | "chat.complete"
  | "engine.status"
  | "plan.usage"
  | "rcBridge.changed"
  | "daemon.stopping"

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
  readonly sessionId: string | null
  readonly tabs: Task["tabs"]
  readonly activeTabId: string
  readonly status: Task["status"]
  readonly archived: boolean
  readonly pinned: boolean
  readonly permissionMode?: Task["permissionMode"]
  readonly model?: string
  readonly modelEffort?: Task["modelEffort"]
  readonly vendor?: Task["vendor"]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SerializedHistoryPage {
  readonly messages: Message[]
  readonly usageMetrics?: SessionUsageMetrics
  readonly nextBefore: string | null
  readonly hasMore: boolean
}

export function serializeTask(task: Task): SerializedTask {
  return {
    id: task.id,
    title: task.title,
    repo: task.repo,
    branch: task.branch,
    worktreePath: task.worktreePath,
    kind: task.kind ?? "task",
    sessionId: task.sessionId,
    tabs: task.tabs,
    activeTabId: task.activeTabId,
    status: task.status,
    archived: task.archived,
    pinned: task.pinned ?? false,
    permissionMode: task.permissionMode,
    model: task.model,
    modelEffort: task.modelEffort,
    vendor: task.vendor,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function serializeMessages(messages: readonly Message[]): Message[] {
  return messages.map((m) => ({ ...m }))
}

export function normalizeEventForWire(taskId: string, tabId: string, ev: OrchestratorEvent): DaemonFrame {
  if (ev.type === "assistant.delta") {
    return {
      type: "event",
      name: "chat.delta",
      payload: { taskId, tabId, delta: ev.text },
    }
  }
  if (ev.type === "done") {
    return {
      type: "event",
      name: "chat.complete",
      payload: { taskId, tabId },
    }
  }
  if (ev.type === "error") {
    return {
      type: "event",
      name: "engine.status",
      payload: { taskId, tabId, status: "error", message: ev.message },
    }
  }
  return {
    type: "event",
    name: "chat.event",
    payload: { taskId, tabId, event: ev },
  }
}

export function frameToLine(frame: DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}
