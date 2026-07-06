export interface ExternalStore<T> {
  get(): T
  set(next: T): void
  update(fn: (current: T) => T): void
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
