/**
 * Bridge client — one EventSource to /events feeds a module-level store
 * that React reads via useSyncExternalStore. Mutations go through rpc()
 * (POST /api/rpc); the daemon's authoritative state comes back as a
 * task.snapshot push, so we never optimistically mutate the store here.
 */

import { useSyncExternalStore } from "react"
import { pruneMissingTasks } from "./tabs.ts"
import type {
  BridgeEvent,
  BridgeSnapshot,
  EngineState,
  Task,
  TaskJob,
  UpdateInfo,
  WorktreeChangeCounts,
} from "./types.ts"

export interface AppState {
  tasks: Task[]
  activeTaskId: string | null
  engineStates: Record<string, EngineState>
  update: UpdateInfo | null
  /** taskId → in-flight long job (e.g. a worktree materializing). */
  jobs: Record<string, TaskJob>
  /** worktreePath → uncommitted +added/−deleted counts. */
  worktreeChanges: WorktreeChangeCounts
  /** True once the first snapshot has hydrated the store. */
  hydrated: boolean
  /** The daemon connection behind the bridge is live. */
  daemonConnected: boolean
  /** The browser↔bridge SSE stream is open. */
  streamConnected: boolean
}

const initial: AppState = {
  tasks: [],
  activeTaskId: null,
  engineStates: {},
  update: null,
  jobs: {},
  worktreeChanges: {},
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

/** Drop per-task entries whose task no longer exists in the snapshot. */
function pruneByTask<T>(
  map: Record<string, T>,
  live: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(map).filter(([taskId]) => live.has(taskId))
  return entries.length === Object.keys(map).length
    ? map
    : Object.fromEntries(entries)
}

/** A task.snapshot is the authoritative task list — sweep every per-task
 *  side table (engine badges, jobs, workspace tabs + their PTYs) for tasks
 *  that no longer exist, so a delete in ANY surface (TUI, api, another
 *  browser) cleans this one up too. */
function applyTaskList(tasks: Task[]): void {
  const live = new Set(tasks.map((t) => t.id))
  set({
    tasks,
    engineStates: pruneByTask(state.engineStates, live),
    jobs: pruneByTask(state.jobs, live),
  })
  pruneMissingTasks(live)
}

function applyEvent(event: BridgeEvent): void {
  switch (event.channel) {
    case "task.snapshot":
      applyTaskList(event.payload.tasks)
      break
    case "active-task":
      set({ activeTaskId: event.payload.taskId })
      break
    case "engine-state":
      set({
        engineStates: {
          ...state.engineStates,
          [event.payload.taskId]: event.payload,
        },
      })
      break
    case "update":
      set({ update: event.payload.info })
      break
    case "task.jobs": {
      const job = event.payload
      if (job.phase === "running") {
        set({ jobs: { ...state.jobs, [job.taskId]: job } })
      } else {
        const { [job.taskId]: _done, ...jobs } = state.jobs
        set({ jobs })
      }
      break
    }
    case "worktree.changes":
      set({ worktreeChanges: event.payload.changes })
      break
  }
}

let source: EventSource | null = null

function ensureStream(): void {
  if (source) return
  source = new EventSource("/events")
  source.addEventListener("open", () => set({ streamConnected: true }))
  source.addEventListener("snapshot", (e) => {
    const snap = JSON.parse((e as MessageEvent).data) as BridgeSnapshot
    set({
      tasks: snap.tasks,
      activeTaskId: snap.activeTaskId,
      engineStates: snap.engineStates,
      update: snap.update,
      jobs: snap.jobs ?? {},
      worktreeChanges: snap.worktreeChanges ?? {},
      hydrated: true,
      daemonConnected: snap.connected,
      streamConnected: true,
    })
    // Snapshot from a LIVE daemon is authoritative — sweep tabs/PTYs of
    // tasks deleted while this browser was away. A disconnected snapshot
    // carries the bridge's stale mirror; never prune from that.
    if (snap.connected) pruneMissingTasks(new Set(snap.tasks.map((t) => t.id)))
  })
  source.addEventListener("channel", (e) => {
    applyEvent(JSON.parse((e as MessageEvent).data) as BridgeEvent)
    if (!state.daemonConnected) set({ daemonConnected: true })
  })
  source.addEventListener("error", () => set({ streamConnected: false }))
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

/** Forward a daemon RPC. Resolves with the daemon's result, throws on error. */
export async function rpc<T = unknown>(
  name: string,
  payload?: unknown,
): Promise<T> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, payload }),
  })
  const json = (await res.json()) as { result?: T; error?: string }
  if (!res.ok || json.error)
    throw new Error(json.error ?? `rpc ${name} failed (${res.status})`)
  return json.result as T
}
