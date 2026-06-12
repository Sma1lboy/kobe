/**
 * Bridge client — one EventSource to /events feeds a module-level store
 * that React reads via useSyncExternalStore. Mutations go through rpc()
 * (POST /api/rpc); the daemon's authoritative state comes back as a
 * task.snapshot push, so we never optimistically mutate the store here.
 */

import { useSyncExternalStore } from "react"
import { deliverToSession } from "./dispatch-delivery.ts"
import { notifyEngineTransition } from "./notify.ts"
import { pruneMissingTasks } from "./tabs.ts"
import { applyThemeFromPrefs } from "./theme.ts"
import type {
  BridgeEvent,
  BridgeSnapshot,
  ConflictPair,
  EngineState,
  SessionDeliver,
  Task,
  TaskJob,
  UiPrefs,
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
  /** Conflict-radar pairs (daemon-collected; board yarn + badges). */
  conflicts: ConflictPair[]
  /** Most recent dispatcher delivery (display only; delivery itself is the
   *  dispatch-delivery forwarder's job). */
  deliver: SessionDeliver | null
  /** Persisted visual prefs shared with the TUI (theme, sort mode). */
  uiPrefs: UiPrefs | null
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
  conflicts: [],
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

/** Drop per-task entries whose task no longer exists in the snapshot. Returns
 *  the SAME reference when nothing changed (so React skips a needless update).
 *  Exported for tests. */
export function pruneByTask<T>(
  map: Record<string, T>,
  live: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(map).filter(([taskId]) => live.has(taskId))
  return entries.length === Object.keys(map).length
    ? map
    : Object.fromEntries(entries)
}

/** A delete publishes task.snapshot (task gone) THEN a trailing idle
 *  engine-state for the same id. An idle state for a task that no longer
 *  exists is that orphan — drop it so the badge map stays clean. A NON-idle
 *  state for an unknown task is a mid-creation race, not an orphan, so it's
 *  kept. Exported for tests. */
export function isOrphanIdleEngineState(
  task: Task | undefined,
  state: EngineState["state"],
): boolean {
  return !task && state === "idle"
}

/** Reduce a task.jobs event into the jobs map: a running job is tracked by
 *  taskId; any terminal phase (done/error) clears its entry. Returns a new map
 *  on a running insert and on a delete that hit; a delete that misses still
 *  returns a fresh object (cheap, rare). Exported for tests. */
export function applyJobEvent(
  jobs: Record<string, TaskJob>,
  job: TaskJob,
): Record<string, TaskJob> {
  if (job.phase === "running") return { ...jobs, [job.taskId]: job }
  const { [job.taskId]: _done, ...rest } = jobs
  return rest
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
    case "engine-state": {
      const prev = state.engineStates[event.payload.taskId]?.state
      const task = state.tasks.find((t) => t.id === event.payload.taskId)
      // Skip the trailing idle engine-state a delete emits after its snapshot
      // (it self-heals on the next snapshot, but skipping keeps the map clean).
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
    case "task.conflicts":
      set({ conflicts: event.payload.pairs })
      break
    case "session.deliver":
      // This SPA hosts web sessions, so it owns the paste (dedupe inside).
      set({ deliver: event.payload })
      void deliverToSession(event.payload)
      break
    case "ui-prefs":
      set({ uiPrefs: event.payload })
      applyThemeFromPrefs(event.payload.theme)
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
      conflicts: snap.conflicts ?? [],
      deliver: snap.deliver ?? null,
      uiPrefs: snap.uiPrefs ?? null,
      hydrated: true,
      daemonConnected: snap.connected,
      streamConnected: true,
    })
    if (snap.uiPrefs) applyThemeFromPrefs(snap.uiPrefs.theme)
    // A snapshot replays the most recent session.deliver — forward it too
    // (the forwarder's `at` dedupe makes a re-replay a no-op), so a deliver
    // published while no browser was open still lands on the next visit.
    if (snap.connected && snap.deliver) void deliverToSession(snap.deliver)
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
  const json = (await res.json()) as {
    result?: T
    error?: string
    name?: string
  }
  if (!res.ok || json.error) {
    const err = new Error(json.error ?? `rpc ${name} failed (${res.status})`)
    // The bridge forwards the daemon's error name (e.g.
    // IllegalTransitionError) so callers can branch without string-matching.
    if (json.name) err.name = json.name
    throw err
  }
  return json.result as T
}
