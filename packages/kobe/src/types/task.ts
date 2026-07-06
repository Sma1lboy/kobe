declare const TaskIdBrand: unique symbol
export type TaskId = string & { readonly [TaskIdBrand]: never }

export const toTaskId = (id: string): TaskId => id as TaskId

export type { VendorId } from "./vendor.ts"
import type { VendorId } from "./vendor.ts"

export const DEFAULT_TASK_VENDOR: VendorId = "claude"

export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done" | "canceled" | "error"

export const TASK_STATUSES = [
  "backlog",
  "in_progress",
  "in_review",
  "done",
  "canceled",
  "error",
] as const satisfies readonly TaskStatus[]

true satisfies Exclude<TaskStatus, (typeof TASK_STATUSES)[number]> extends never ? true : false

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
}

export type PRProviderId = "github" | "gitlab" | "bitbucket" | "unknown"
export type PRCheckState = "none" | "pending" | "passing" | "failing" | "unknown"
export type PRLifecycleState = "creating" | "open" | "ready_to_merge" | "merged" | "closed" | "unknown"

export interface TaskPRStatus {
  readonly provider: PRProviderId
  readonly lifecycle: PRLifecycleState
  readonly checkState: PRCheckState
  readonly number?: number
  readonly url?: string
  readonly title?: string
  readonly baseRef?: string
  readonly headRef?: string
  readonly reviewDecision?: string
  readonly mergeable?: string
  readonly lastCheckedAt?: string
  readonly lastError?: string
}

export interface Task {
  readonly id: TaskId
  readonly title: string
  readonly repo: string
  readonly branch: string
  readonly worktreePath: string
  readonly kind?: "main" | "task"
  readonly status: TaskStatus
  readonly archived: boolean
  readonly pinned?: boolean
  readonly vendor?: VendorId
  readonly prStatus?: TaskPRStatus
  readonly position?: number
  readonly modelEffort?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TaskIndex {
  readonly version: 3
  readonly tasks: readonly Task[]
}
