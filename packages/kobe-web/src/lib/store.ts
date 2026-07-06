import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { useSyncExternalStore } from "react"
import { deliverToSession } from "./dispatch-delivery.ts"
import { notifyEngineTransition } from "./notify.ts"
import { pruneSnapshotAliases, repoSnapshotAliases } from "./repo-key.ts"
import { daemonRpc } from "./rpc-client.ts"
import { pruneMissingTasks } from "./tabs.ts"
import { applyThemeFromPrefs } from "./theme.ts"
import type {
  EngineState,
  RepoIssues,
  SessionDeliver,
  Task,
  TaskJob,
  UiPrefs,
  UpdateInfo,
  WebTransportEvent,
  WebTransportSnapshot,
  WorktreeChangeCounts,
} from "./types.ts"

export interface AppState {
  tasks: Task[]
  activeTaskId: string | null
  engineStates: Record<string, EngineState>
  update: UpdateInfo | null
  jobs: Record<string, TaskJob>
  worktreeChanges: WorktreeChangeCounts
  issueSnapshots: Record<string, RepoIssues>
  deliver: SessionDeliver | null
  uiPrefs: UiPrefs | null
  hydrated: boolean
  daemonConnected: boolean
  streamConnected: boolean
}

const initial: AppState = {
  tasks: [],
  activeTaskId: null,
  engineStates: {},
  update: null,
  jobs: {},
  worktreeChanges: {},
  issueSnapshots: {},
  deliver: null,
  uiPrefs: null,
  hydrated: false,
  daemonConnected: false,
  streamConnected: false,
}

let state: AppState = initial
const listeners = new Set<() => void>()

function set(next: Partial<AppState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export function pruneByTask<T>(
  map: Record<string, T>,
  live: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(map).filter(([taskId]) => live.has(taskId))
  return entries.length === Object.keys(map).length
    ? map
    : Object.fromEntries(entries)
}

export function isOrphanIdleEngineState(
  task: Task | undefined,
  state: EngineState["state"],
): boolean {
  return !task && state === "idle"
}

export function applyJobEvent(
  jobs: Record<string, TaskJob>,
  job: TaskJob,
): Record<string, TaskJob> {
  if (job.phase === "running") return { ...jobs, [job.taskId]: job }
  const { [job.taskId]: _done, ...rest } = jobs
  return rest
}

function applyIssueSnapshotEvent(
  snapshots: Record<string, RepoIssues>,
  tasks: readonly Task[],
  snapshot: RepoIssues,
): Record<string, RepoIssues> {
  const next = { ...snapshots }
  for (const alias of repoSnapshotAliases(tasks, snapshot.repoRoot)) {
    next[alias] = { ...snapshot, repoRoot: alias }
  }
  return next
}

function applyTaskList(tasks: Task[]): void {
  const live = new Set(tasks.map((t) => t.id))
  set({
    tasks,
    engineStates: pruneByTask(state.engineStates, live),
    jobs: pruneByTask(state.jobs, live),
    issueSnapshots: pruneSnapshotAliases(state.issueSnapshots, tasks),
  })
  pruneMissingTasks(live)
}

function applyEvent(event: WebTransportEvent): void {
  switch (event.channel) {
    case "task.snapshot":
      applyTaskList(event.payload.tasks)
      break
    case "active-task":
      set({ activeTaskId: event.payload.taskId })
      break
    case "engine-state": {
      const prev = state.engineStates[event.payload.taskId]?.state
      const task = state.tasks.find((t) => t.id === event.payload.taskId)
      if (isOrphanIdleEngineState(task, event.payload.state)) break
      notifyEngineTransition(
        event.payload.taskId,
        task?.title || task?.branch || event.payload.taskId,
        prev,
        event.payload.state,
      )
      set({
        engineStates: {
          ...state.engineStates,
          [event.payload.taskId]: event.payload,
        },
      })
      break
    }
    case "update":
      set({ update: event.payload.info })
      break
    case "task.jobs":
      set({ jobs: applyJobEvent(state.jobs, event.payload) })
      break
    case "worktree.changes":
      set({ worktreeChanges: event.payload.changes })
      break
    case "issue.snapshot":
      set({
        issueSnapshots: applyIssueSnapshotEvent(
          state.issueSnapshots,
          state.tasks,
          event.payload,
        ),
      })
      break
    case "session.deliver":
      set({ deliver: event.payload })
      void deliverToSession(event.payload)
      break
    case "ui-prefs":
      set({ uiPrefs: event.payload })
      applyThemeFromPrefs(event.payload.theme)
      break
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateSnapshot(raw: unknown): WebTransportSnapshot | null {
  if (!isRecord(raw)) return null
  if (!Array.isArray(raw.tasks)) return null
  if (typeof raw.activeTaskId !== "string" && raw.activeTaskId !== null) {
    return null
  }
  if (!isRecord(raw.engineStates)) return null
  if (typeof raw.connected !== "boolean") return null
  for (const key of ["jobs", "worktreeChanges", "issueSnapshots"] as const) {
    if (raw[key] !== undefined && !isRecord(raw[key])) return null
  }
  if (
    raw.uiPrefs !== undefined &&
    raw.uiPrefs !== null &&
    !isRecord(raw.uiPrefs)
  ) {
    return null
  }
  return raw as unknown as WebTransportSnapshot
}

export function reconnectDelay(attempt: number): number {
  const base = 500
  const cap = 10_000
  return Math.min(cap, base * 2 ** Math.max(0, attempt))
}

let source: EventSource | null = null
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function isStreamReusable(s: EventSource | null): boolean {
  return s !== null && s.readyState !== EventSource.CLOSED
}

function applySnapshot(snap: WebTransportSnapshot): void {
  reconnectAttempts = 0
  set({
    tasks: snap.tasks,
    activeTaskId: snap.activeTaskId,
    engineStates: snap.engineStates,
    update: snap.update,
    jobs: snap.jobs ?? {},
    worktreeChanges: snap.worktreeChanges ?? {},
    issueSnapshots: snap.issueSnapshots ?? {},
    deliver: snap.deliver ?? null,
    uiPrefs: snap.uiPrefs ?? null,
    hydrated: true,
    daemonConnected: snap.connected,
    streamConnected: true,
  })
  if (snap.uiPrefs) applyThemeFromPrefs(snap.uiPrefs.theme)
  if (snap.connected && snap.deliver) void deliverToSession(snap.deliver)
  if (snap.connected) {
    const live = new Set(snap.tasks.map((t) => t.id))
    pruneMissingTasks(live)
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  const delay = reconnectDelay(reconnectAttempts)
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (listeners.size > 0) ensureStream()
  }, delay)
}

function ensureStream(): void {
  if (isStreamReusable(source)) return
  source = new EventSource("/events")
  source.addEventListener("open", () => {
    reconnectAttempts = 0
    set({ streamConnected: true })
  })
  source.addEventListener("snapshot", (e) => {
    let parsed: unknown
    try {
      parsed = JSON.parse((e as MessageEvent).data)
    } catch {
      console.warn("[store] dropped unparseable snapshot frame")
      return
    }
    const snap = validateSnapshot(parsed)
    if (!snap) {
      console.warn("[store] dropped malformed snapshot frame")
      return
    }
    applySnapshot(snap)
  })
  source.addEventListener("channel", (e) => {
    let event: unknown
    try {
      event = JSON.parse((e as MessageEvent).data)
    } catch {
      console.warn("[store] dropped unparseable channel frame")
      return
    }
    if (!isRecord(event) || typeof event.channel !== "string") {
      console.warn("[store] dropped malformed channel frame")
      return
    }
    applyEvent(event as WebTransportEvent)
    if (!state.daemonConnected) set({ daemonConnected: true })
  })
  source.addEventListener("error", () => {
    set({ streamConnected: false })
    if (source && source.readyState === EventSource.CLOSED) {
      source.close()
      source = null
      scheduleReconnect()
    }
  })
}

export function subscribe(listener: () => void): () => void {
  ensureStream()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): AppState {
  return state
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export async function rpc<T = unknown>(
  name: DaemonRequestName,
  payload?: unknown,
): Promise<T> {
  return daemonRpc.request<T>(name, payload)
}
