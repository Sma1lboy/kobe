/**
 * Daemon web client — one EventSource to /events feeds a module-level store
 * that React reads via useSyncExternalStore. Mutations go through rpc()
 * (POST /api/rpc); the daemon's authoritative state comes back as a
 * task.snapshot push, so we never optimistically mutate the store here.
 */

import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { useSyncExternalStore } from "react"
import { deliverToSession } from "./dispatch-delivery.ts"
import { notifyEngineTransition } from "./notify.ts"
import { repoSnapshotAliases } from "./repo-key.ts"
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
  /** taskId → in-flight long job (e.g. a worktree materializing). */
  jobs: Record<string, TaskJob>
  /** worktreePath → uncommitted +added/−deleted counts. */
  worktreeChanges: WorktreeChangeCounts
  /** repoRoot (+ worktree aliases) → daemon-owned issue state from live
   *  `issue.snapshot` pushes (web Issues page). */
  issueSnapshots: Record<string, RepoIssues>
  /** Most recent dispatcher delivery (display only; delivery itself is the
   *  dispatch-delivery forwarder's job). */
  deliver: SessionDeliver | null
  /** Persisted visual prefs shared with the TUI (theme, sort mode). */
  uiPrefs: UiPrefs | null
  /** True once the first snapshot has hydrated the store. */
  hydrated: boolean
  /** The daemon behind the web transport is live. */
  daemonConnected: boolean
  /** The browser SSE stream to the daemon web transport is open. */
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

function applyIssueSnapshotEvent(
  snapshots: Record<string, RepoIssues>,
  tasks: readonly Task[],
  snapshot: RepoIssues,
): Record<string, RepoIssues> {
  const next = { ...snapshots }
  // repo-key owns the aliasing contract (shared with server-side route helpers).
  for (const alias of repoSnapshotAliases(tasks, snapshot.repoRoot)) {
    next[alias] = { ...snapshot, repoRoot: alias }
  }
  return next
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate the shape of a `snapshot` frame before applying it. The SSE frame
 *  is untrusted bytes: a malformed/partial frame (e.g. `tasks` not an array)
 *  would crash the store on the next `.map`/`.find`, wedging the dashboard. We
 *  guard the load-bearing fields (the ones the store immediately iterates) and
 *  drop the whole frame if any is wrong, mirroring how the TUI client refuses
 *  malformed events instead of trusting the wire. Returns the typed snapshot on
 *  success, `null` on a malformed frame (caller logs + drops). Exported for
 *  tests. */
export function validateSnapshot(raw: unknown): WebTransportSnapshot | null {
  if (!isRecord(raw)) return null
  if (!Array.isArray(raw.tasks)) return null
  if (typeof raw.activeTaskId !== "string" && raw.activeTaskId !== null) {
    return null
  }
  if (!isRecord(raw.engineStates)) return null
  if (typeof raw.connected !== "boolean") return null
  // Optional maps, when present, must be objects (the store spreads/iterates
  // them); a present-but-wrong type is as fatal as a bad `tasks`.
  for (const key of [
    "jobs",
    "worktreeChanges",
    "issueSnapshots",
  ] as const) {
    if (raw[key] !== undefined && !isRecord(raw[key])) return null
  }
  if (raw.uiPrefs !== undefined && raw.uiPrefs !== null && !isRecord(raw.uiPrefs)) {
    return null
  }
  return raw as unknown as WebTransportSnapshot
}

/** Bounded exponential backoff for SSE auto-reconnect: 500ms, 1s, 2s, 4s, …
 *  capped at 10s. `attempt` is 0-based (0 = first retry). Exported for tests. */
export function reconnectDelay(attempt: number): number {
  const base = 500
  const cap = 10_000
  return Math.min(cap, base * 2 ** Math.max(0, attempt))
}

let source: EventSource | null = null
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

/** A stream is "live enough" to reuse when its EventSource exists and hasn't
 *  reached CLOSED — CONNECTING (the browser's own retry) and OPEN both count.
 *  Once CLOSED, the source is dead and must be replaced; the old code's bare
 *  `if (source) return` left a CLOSED source assigned, so after a daemon
 *  restart every later subscribe()/ensureStream() early-returned and the
 *  dashboard wedged on "connecting…" until a full browser refresh. */
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
  // A snapshot replays the most recent session.deliver — forward it too
  // (the forwarder's `at` dedupe makes a re-replay a no-op), so a deliver
  // published while no browser was open still lands on the next visit.
  if (snap.connected && snap.deliver) void deliverToSession(snap.deliver)
  // Snapshot from a LIVE daemon is authoritative — sweep tabs/PTYs of
  // tasks deleted while this browser was away. A disconnected snapshot
  // carries the transport's stale mirror; never prune from that.
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
    // Only reconnect while React still cares; with no listeners the next
    // subscribe() will re-open lazily anyway.
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
    // EventSource auto-reconnects from CONNECTING on its own; only when it
    // reaches CLOSED (the daemon dropped the stream and the browser gave up)
    // must we replace it. Null it out so isStreamReusable lets a fresh open
    // through, then drive a bounded backoff so the dashboard self-heals after
    // a daemon restart instead of wedging until a manual refresh.
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

/** Forward a daemon RPC. Resolves with the daemon's result, throws on error. */
export async function rpc<T = unknown>(
  name: DaemonRequestName,
  payload?: unknown,
): Promise<T> {
  return daemonRpc.request<T>(name, payload)
}
