/**
 * Minimal framework-free observable store — the React migration's stand-in
 * for the Solid module-level `createStore`/`createSignal` singletons (issue
 * #15, G2). Solid modules get reactivity for free by reading a store inside
 * a tracked scope; React needs an explicit subscribe/getSnapshot pair for
 * `useSyncExternalStore`. This helper is deliberately tiny: synchronous
 * notify, identity-compared snapshots, no selectors — module singletons in
 * this codebase hold small value objects, not collections.
 */

export interface ExternalStore<T> {
  get(): T
  /** Replace the snapshot and notify when the reference actually changed. */
  set(next: T): void
  /** Functional update over the current snapshot. */
  update(fn: (current: T) => T): void
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    get: () => snapshot,
    set(next: T) {
      if (Object.is(next, snapshot)) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    update(fn) {
      this.set(fn(snapshot))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
