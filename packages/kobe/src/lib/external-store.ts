/**
 * Minimal framework-free observable store (issue #15, G2/G3). The React
 * migration's reactive primitive: Solid modules get reactivity for free by
 * reading a store inside a tracked scope; React needs an explicit
 * subscribe/getSnapshot pair for `useSyncExternalStore`. Lives in the
 * framework-free `src/lib/` layer because the daemon CLIENT layer also
 * publishes live state through it (remote-orchestrator's ui-prefs /
 * keybindings-rev stores) — deliberately independent of solid-js, whose
 * reactivity is dead under node/vitest and plain-bun resolution (they get
 * the SSR server build; only --conditions=browser or the build-time plugin
 * swap yield the reactive build). Tiny on purpose: synchronous notify,
 * identity-compared snapshots, no selectors.
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
