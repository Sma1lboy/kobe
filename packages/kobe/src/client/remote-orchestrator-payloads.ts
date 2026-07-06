import type { ChannelName, SerializedTask, SubscribeRole, UiPrefsPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { Accessor } from "solid-js"
import type { EngineActivityDetail, TaskActivityState } from "../engine/hook-events.ts"
import { type WorktreeChanges, sameWorktreeChanges } from "../tui/panes/sidebar/worktree-changes.ts"
import type { Task } from "../types/task.ts"
import { toTaskId } from "../types/task.ts"
import type { UpdateInfo } from "../version.ts"

export interface TaskEngineState {
  readonly state: TaskActivityState
  readonly detail?: EngineActivityDetail
  readonly at: number
}

export interface TaskJobState {
  readonly kind: "ensureWorktree"
}

export type WorktreeChangesMap = ReadonlyMap<string, WorktreeChanges>

export function describePayload(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  const type = Array.isArray(value) ? "array" : typeof value
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text.length > 120) text = `${text.slice(0, 120)}…`
  return `${type}:${text}`
}

export function parseWorktreeChangesPayload(payload: unknown): Map<string, WorktreeChanges> | null {
  const changes = (payload as { changes?: unknown } | undefined)?.changes
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null
  const map = new Map<string, WorktreeChanges>()
  for (const [path, value] of Object.entries(changes as Record<string, unknown>)) {
    const counts = value as { added?: unknown; deleted?: unknown } | undefined
    if (typeof counts?.added !== "number" || typeof counts.deleted !== "number") return null
    map.set(path, { added: counts.added, deleted: counts.deleted })
  }
  return map
}

export function decodeUiPrefsPayload(payload: unknown): UiPrefsPayload | null {
  const p = payload as Partial<UiPrefsPayload> | undefined
  if (typeof p?.theme !== "string") return null
  return {
    theme: p.theme,
    transparentBackground: p.transparentBackground === true,
    focusAccent: typeof p.focusAccent === "string" ? p.focusAccent : null,
    locale: typeof p.locale === "string" ? p.locale : "",
    sortMode: p.sortMode === "recent" ? "recent" : "default",
    keysCollapsed: p.keysCollapsed === true,
    projectFilter: typeof p.projectFilter === "string" && p.projectFilter.length > 0 ? p.projectFilter : null,
  }
}

export function sameWorktreeChangesMap(a: WorktreeChangesMap, b: WorktreeChangesMap): boolean {
  if (a.size !== b.size) return false
  for (const [path, counts] of a) {
    const other = b.get(path)
    if (!other || !sameWorktreeChanges(counts, other)) return false
  }
  return true
}

export interface TranscriptActivity {
  readonly mtimeMs: number
  readonly completionId: string | null
  readonly completionAt: number
}

export type TranscriptActivityMap = ReadonlyMap<string, TranscriptActivity>

export function parseTranscriptActivityPayload(payload: unknown): Map<string, TranscriptActivity> | null {
  const activity = (payload as { activity?: unknown } | undefined)?.activity
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return null
  const map = new Map<string, TranscriptActivity>()
  for (const [path, value] of Object.entries(activity as Record<string, unknown>)) {
    const v = value as { mtimeMs?: unknown; completionId?: unknown; completionAt?: unknown } | undefined
    if (typeof v?.mtimeMs !== "number" || typeof v.completionAt !== "number") return null
    if (v.completionId !== null && typeof v.completionId !== "string") return null
    map.set(path, { mtimeMs: v.mtimeMs, completionId: v.completionId, completionAt: v.completionAt })
  }
  return map
}

export function sameTranscriptActivityMap(a: TranscriptActivityMap, b: TranscriptActivityMap): boolean {
  if (a.size !== b.size) return false
  for (const [path, v] of a) {
    const other = b.get(path)
    if (
      !other ||
      other.mtimeMs !== v.mtimeMs ||
      other.completionId !== v.completionId ||
      other.completionAt !== v.completionAt
    )
      return false
  }
  return true
}

export type DaemonConnectionState = "online" | "disconnected"

export interface RemoteOrchestratorOptions {
  readonly ensureReachable?: () => Promise<unknown>
  readonly role?: SubscribeRole
  readonly channels?: readonly ChannelName[]
}

export interface OrchestratorSignals {
  readonly tasksAcc: Accessor<Task[]>
  readonly setTasks: (next: Task[]) => void
  readonly setActiveTaskSig: (next: string | null) => void
  readonly setUpdateSig: (next: UpdateInfo | null) => void
  readonly setDaemonVersionSig: (next: string | null) => void
  readonly engineStateAcc: Accessor<ReadonlyMap<string, TaskEngineState>>
  readonly setEngineStateSig: (next: ReadonlyMap<string, TaskEngineState>) => void
  readonly taskJobsAcc: Accessor<ReadonlyMap<string, TaskJobState>>
  readonly setTaskJobsSig: (next: ReadonlyMap<string, TaskJobState>) => void
  readonly worktreeChangesAcc: Accessor<WorktreeChangesMap | null>
  readonly setWorktreeChangesSig: (next: WorktreeChangesMap | null) => void
  readonly transcriptActivityAcc: Accessor<TranscriptActivityMap | null>
  readonly setTranscriptActivitySig: (next: TranscriptActivityMap | null) => void
  readonly setUiPrefsSig: (next: UiPrefsPayload | null) => void
  readonly setKeybindingsRevSig: (next: number | null) => void
  readonly setConnectionState: (next: DaemonConnectionState) => void
}

export function deserializeTask(s: SerializedTask): Task {
  return {
    id: toTaskId(s.id),
    title: s.title,
    repo: s.repo,
    branch: s.branch,
    worktreePath: s.worktreePath,
    kind: s.kind,
    status: s.status,
    archived: s.archived,
    pinned: s.pinned,
    vendor: s.vendor,
    prStatus: s.prStatus,
    modelEffort: s.modelEffort,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}
