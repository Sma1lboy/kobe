import { createExternalStore } from "../../lib/external-store"
import { loadStateFile, patchStateFile, replaceStateFile } from "../../state/store.ts"

const WRITE_DEBOUNCE_MS = 250

export interface KvCore {
  snapshot(): Record<string, unknown>
  subscribe(listener: () => void): () => void
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
  seed(key: string, value: unknown): void
  flush(): boolean
  clear(): void
}

export function createKvCore(): KvCore {
  const store = createExternalStore<Record<string, unknown>>(loadStateFile())

  const dirtyKeys = new Set<string>()
  let writeTimer: ReturnType<typeof setTimeout> | null = null

  function writeNow(label: string): boolean {
    if (dirtyKeys.size === 0) return true
    try {
      const patch: Record<string, unknown> = {}
      const snap = store.get()
      for (const key of dirtyKeys) patch[key] = snap[key]
      patchStateFile(patch)
      dirtyKeys.clear()
      return true
    } catch (err) {
      console.error(`[kobe] kv ${label} failed:`, err)
      return false
    }
  }

  function cancelTimer(): void {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
  }

  function scheduleWrite(): void {
    cancelTimer()
    writeTimer = setTimeout(() => {
      writeTimer = null
      writeNow("write")
    }, WRITE_DEBOUNCE_MS)
  }

  return {
    snapshot: store.get,
    subscribe: store.subscribe,
    get(key, defaultValue) {
      return store.get()[key] ?? defaultValue
    },
    set(key, value) {
      store.update((s) => ({ ...s, [key]: value }))
      dirtyKeys.add(key)
      scheduleWrite()
    },
    seed(key, value) {
      if (store.get()[key] !== undefined) return
      store.update((s) => ({ ...s, [key]: value }))
    },
    flush() {
      cancelTimer()
      return writeNow("flush")
    },
    clear() {
      cancelTimer()
      dirtyKeys.clear()
      store.set({})
      try {
        replaceStateFile({})
      } catch (err) {
        console.error("[kobe] kv clear write failed:", err)
      }
    },
  }
}
