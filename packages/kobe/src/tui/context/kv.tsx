import type { Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { loadStateFile, patchStateFile, replaceStateFile } from "../../state/store.ts"
import { createSimpleContext } from "./helper"

const WRITE_DEBOUNCE_MS = 250

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [store, setStore] = createStore<Record<string, unknown>>(loadStateFile())

    const dirtyKeys = new Set<string>()

    let writeTimer: ReturnType<typeof setTimeout> | null = null
    function writeNow(label: string): boolean {
      if (dirtyKeys.size === 0) return true
      try {
        const patch: Record<string, unknown> = {}
        for (const key of dirtyKeys) patch[key] = store[key]
        patchStateFile(patch)
        dirtyKeys.clear()
        return true
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[kobe] kv ${label} failed:`, err)
        return false
      }
    }

    function scheduleWrite(): void {
      if (writeTimer) clearTimeout(writeTimer)
      writeTimer = setTimeout(() => {
        writeTimer = null
        writeNow("write")
      }, WRITE_DEBOUNCE_MS)
    }

    const result = {
      get ready() {
        return true
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue as unknown)
        return [() => result.get(name) as T, (next: Setter<T>) => result.set(name, next)] as const
      },
      get(key: string, defaultValue?: unknown) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: unknown) {
        setStore(key, value)
        dirtyKeys.add(key)
        scheduleWrite()
      },
      flush(): boolean {
        if (writeTimer) {
          clearTimeout(writeTimer)
          writeTimer = null
        }
        return writeNow("flush")
      },
      clear() {
        for (const k of Object.keys(store)) setStore(k, undefined as unknown)
        if (writeTimer) {
          clearTimeout(writeTimer)
          writeTimer = null
        }
        dirtyKeys.clear()
        try {
          replaceStateFile({})
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[kobe] kv clear write failed:", err)
        }
      },
    }
    return result
  },
})

export type KVContext = ReturnType<typeof useKV>
