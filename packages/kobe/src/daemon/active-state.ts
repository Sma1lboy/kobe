/**
 * Daemon-wide "active task" state — a pure observable that the rpc.*
 * handlers mutate and the active.changed event broadcasts to attached
 * clients.
 *
 * Why a dedicated module: the orchestrator already tracks `activeTabId`
 * per task (which tab inside a task is foregrounded), but nothing knew
 * which task is foregrounded daemon-wide. The tmux pane subprocesses
 * each need that single number; rather than threading it through every
 * orchestrator handler we keep it here, behind a tiny `get/set/next/prev`
 * surface that callers pass into.
 *
 * Pure: holds an id + listeners, knows nothing about the orchestrator
 * (the caller passes in the task-id array for next/prev so the cycle
 * order respects orchestrator-side ordering, archived filtering, etc.).
 */

export type ActiveStateListener = (activeTaskId: string | null) => void

export interface ActiveState {
  /** Current active task id. `null` when nothing is active (no tasks, or after delete). */
  get(): string | null
  /** Set the active task id (or clear with `null`). No-op when already that id. */
  set(taskId: string | null): void
  /**
   * Advance to the next task id in `taskIds` (cycle to start at the end).
   * If the current active id isn't in the list, jumps to the first entry.
   * No-op when `taskIds` is empty.
   */
  next(taskIds: readonly string[]): void
  /** Mirror of {@link next} but in reverse. */
  prev(taskIds: readonly string[]): void
  /** Subscribe to change events. Returns the unsubscribe handle. */
  onChange(cb: ActiveStateListener): () => void
}

export function createActiveState(initial: string | null = null): ActiveState {
  let current: string | null = initial
  const listeners = new Set<ActiveStateListener>()

  function notify(): void {
    for (const cb of listeners) cb(current)
  }

  return {
    get() {
      return current
    },
    set(taskId) {
      if (current === taskId) return
      current = taskId
      notify()
    },
    next(taskIds) {
      if (taskIds.length === 0) return
      const idx = current === null ? -1 : taskIds.indexOf(current)
      const nextIdx = idx === -1 ? 0 : (idx + 1) % taskIds.length
      const target = taskIds[nextIdx] ?? null
      if (current === target) return
      current = target
      notify()
    },
    prev(taskIds) {
      if (taskIds.length === 0) return
      const idx = current === null ? -1 : taskIds.indexOf(current)
      const prevIdx = idx === -1 ? taskIds.length - 1 : (idx - 1 + taskIds.length) % taskIds.length
      const target = taskIds[prevIdx] ?? null
      if (current === target) return
      current = target
      notify()
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
