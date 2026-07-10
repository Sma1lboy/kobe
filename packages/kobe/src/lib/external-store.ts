/**
 * Framework-free observable state shared by the Orchestrator, daemon client,
 * and React adapters. A state is callable for compatibility with the former
 * Solid Accessor interface, while `get`/`subscribe` plug directly into
 * `useSyncExternalStore`. There is one cell per semantic stream so unrelated
 * daemon channels do not invalidate each other.
 */

export interface ReadableState<T> {
  (): T
  /** Stable snapshot reader. */
  get(): T
  /** Subscribe to later changes; initial delivery is owned by the caller. */
  subscribe(listener: () => void): () => void
}

export interface StateCell<T> extends ReadableState<T> {
  /** Replace the snapshot and notify when the reference actually changed. */
  set(next: T): void
  /** Functional update over the current snapshot. */
  update(fn: (current: T) => T): void
}

/** Backward-compatible name for callers already using the store vocabulary. */
export type ExternalStore<T> = StateCell<T>

export function createStateCell<T>(initial: T): StateCell<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const state = (() => snapshot) as StateCell<T>
  state.get = state
  state.set = (next: T) => {
    if (Object.is(next, snapshot)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  state.update = (fn) => state.set(fn(snapshot))
  state.subscribe = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return state
}

export const createExternalStore = createStateCell

/** Read-only derived state with the source's notification granularity. */
export function mapReadableState<T, U>(source: ReadableState<T>, map: (value: T) => U): ReadableState<U> {
  const get = () => map(source.get())
  const derived = get as ReadableState<U>
  derived.get = get
  derived.subscribe = source.subscribe
  return derived
}
