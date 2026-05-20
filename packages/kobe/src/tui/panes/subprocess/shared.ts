/**
 * Sprint-8 — shared signal store for the `kobe pane <name>` Solid
 * subprocesses. The subprocess connects to the daemon, calls `hello`
 * to seed initial state, then wires task.* / active.changed events
 * into Solid signals so each pane component re-renders reactively on
 * upstream changes.
 *
 * Kept separate from `cli/pane.ts` so the subprocess panes can be
 * imported by Solid components without dragging the CLI args /
 * plain-text render code into the Bun runtime graph.
 */

import { type Accessor, type Setter, createSignal } from "solid-js"
import type { DaemonEventHandler } from "../../../client/index.ts"
import type { DaemonEventName, DaemonRequestName, SerializedTask } from "../../../daemon/protocol.ts"

export interface PaneSubprocessClient {
  connect(): Promise<void>
  request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T>
  on(name: DaemonEventName | "*", handler: DaemonEventHandler): () => void
  close(): void
}

interface HelloPayload {
  readonly tasks: readonly SerializedTask[]
  readonly activeTaskId: string | null
}

interface TaskCreatedPayload {
  readonly task: SerializedTask
}

interface TaskUpdatedPayload {
  readonly taskId: string
  readonly task: SerializedTask
}

interface TaskDeletedPayload {
  readonly taskId: string
}

interface ActiveChangedPayload {
  readonly activeTaskId: string | null
}

export interface PaneSignals {
  tasks: Accessor<readonly SerializedTask[]>
  activeTaskId: Accessor<string | null>
  /** Mutators kept for tests; production code reads via the accessors. */
  setTasks: Setter<readonly SerializedTask[]>
  setActiveTaskId: Setter<string | null>
  /** Accessor for the active task lookup. Returns null when no task is active. */
  activeTask: Accessor<SerializedTask | null>
}

export function createPaneSignals(initial: HelloPayload): PaneSignals {
  const [tasks, setTasks] = createSignal<readonly SerializedTask[]>(initial.tasks)
  const [activeTaskId, setActiveTaskId] = createSignal<string | null>(initial.activeTaskId)
  const activeTask = (): SerializedTask | null => {
    const id = activeTaskId()
    if (id == null) return null
    return tasks().find((t) => t.id === id) ?? null
  }
  return { tasks, activeTaskId, setTasks, setActiveTaskId, activeTask }
}

/** Wire daemon events into the signal store. Returns no-op; subscribers
 * live for the lifetime of the subprocess. */
export function subscribePaneSignals(client: PaneSubprocessClient, signals: PaneSignals): void {
  client.on("task.created", (frame) => {
    const payload = frame.payload as TaskCreatedPayload
    signals.setTasks((prev) => {
      const exists = prev.some((t) => t.id === payload.task.id)
      return exists ? prev.map((t) => (t.id === payload.task.id ? payload.task : t)) : [...prev, payload.task]
    })
  })
  client.on("task.updated", (frame) => {
    const payload = frame.payload as TaskUpdatedPayload
    signals.setTasks((prev) => prev.map((t) => (t.id === payload.taskId ? payload.task : t)))
  })
  client.on("task.deleted", (frame) => {
    const payload = frame.payload as TaskDeletedPayload
    signals.setTasks((prev) => prev.filter((t) => t.id !== payload.taskId))
  })
  client.on("active.changed", (frame) => {
    const payload = frame.payload as ActiveChangedPayload
    signals.setActiveTaskId(payload.activeTaskId)
  })
}
