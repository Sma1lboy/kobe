import { useSyncExternalStore } from "react"

export interface ExternalStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  useSnapshot(): T
  replace(next: T): T
  update(map: (prev: T) => T): T
}

export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()

  function emit(): void {
    for (const listener of listeners) listener()
  }

  const store: ExternalStore<T> = {
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    useSnapshot() {
      return useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        store.getSnapshot,
      )
    },
    replace(next) {
      snapshot = next
      emit()
      return snapshot
    },
    update(map) {
      snapshot = map(snapshot)
      emit()
      return snapshot
    },
  }

  return store
}
