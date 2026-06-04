/**
 * Bridge client — one EventSource to /events feeds a module-level store
 * that React reads via useSyncExternalStore. Mutations go through rpc()
 * (POST /api/rpc); the daemon's authoritative state comes back as a
 * task.snapshot push, so we never optimistically mutate the store here.
 */

import { useSyncExternalStore } from "react"
import type { BridgeEvent, BridgeSnapshot, EngineState, Task, UpdateInfo } from "./types.ts"

export interface AppState {
  tasks: Task[]
  activeTaskId: string | null
  engineStates: Record<string, EngineState>
  update: UpdateInfo | null
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
  daemonConnected: false,
  streamConnected: false,
}

let state: AppState = initial
const listeners = new Set<() => void>()

function set(next: Partial<AppState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function applyEvent(event: BridgeEvent): void {
  switch (event.channel) {
    case "task.snapshot":
      set({ tasks: event.payload.tasks })
      break
    case "active-task":
      set({ activeTaskId: event.payload.taskId })
      break
    case "engine-state":
      set({ engineStates: { ...state.engineStates, [event.payload.taskId]: event.payload } })
      break
    case "update":
      set({ update: event.payload.info })
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
      daemonConnected: snap.connected,
      streamConnected: true,
    })
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
export async function rpc<T = unknown>(name: string, payload?: unknown): Promise<T> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, payload }),
  })
  const json = (await res.json()) as { result?: T; error?: string }
  if (!res.ok || json.error) throw new Error(json.error ?? `rpc ${name} failed (${res.status})`)
  return json.result as T
}
