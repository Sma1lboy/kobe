/**
 * Framework-free KV core (issue #15, G3) — the data + persistence half of
 * the Solid `src/tui/context/kv.tsx` without the Solid store, consumed by
 * the React `KVProvider` and unit-testable under vitest (no @opentui).
 *
 * Semantics preserved from the Solid provider:
 *   - Synchronous snapshot hydration from `state.json` at creation, so the
 *     first render already sees persisted values (no default flash).
 *     Snapshot-only reads — a key another process writes later is not
 *     picked up until restart (longstanding, accepted).
 *   - Writes are debounced (250ms) and DIRTY-KEY MERGED via
 *     `patchStateFile`: only keys THIS process changed since its last
 *     successful flush reach disk, so a concurrent kobe process's writes
 *     are never clobbered by a whole-snapshot write-back (the classic
 *     lost-update bug the Solid provider fixed). Dirty keys survive a
 *     failed flush and retry on the next one.
 *   - `clear()` is the one legitimate whole-file write
 *     (`replaceStateFile({})`): "reset UI state" means wipe EVERYTHING,
 *     including keys other processes wrote after we loaded.
 */

import { createExternalStore } from "../../lib/external-store"
import { loadStateFile, patchStateFile, replaceStateFile } from "../../state/store.ts"

const WRITE_DEBOUNCE_MS = 250

export interface KvCore {
  /** Current in-memory snapshot (immutable per change; React-safe). */
  snapshot(): Record<string, unknown>
  /** Subscribe to snapshot changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  get(key: string, defaultValue?: unknown): unknown
  /** Set + mark dirty + schedule the debounced disk flush. */
  set(key: string, value: unknown): void
  /**
   * In-memory default seeding (the `signal(name, default)` contract): sets
   * the key ONLY when currently undefined, and never marks it dirty — a
   * default must not be persisted just because it was read.
   */
  seed(key: string, value: unknown): void
  /** Synchronously flush pending dirty keys (before process.exit). */
  flush(): boolean
  /** Wipe every persisted key and synchronously write the empty file. */
  clear(): void
}

export function createKvCore(): KvCore {
  const store = createExternalStore<Record<string, unknown>>(loadStateFile())

  /** Keys this process has `set()` since the last successful flush. */
  const dirtyKeys = new Set<string>()
  let writeTimer: ReturnType<typeof setTimeout> | null = null

  function writeNow(label: string): boolean {
    if (dirtyKeys.size === 0) return true // nothing of ours to merge
    try {
      // Read-merge-write: only OUR dirty keys are applied onto a fresh
      // read of the file. A key set to `undefined` locally serializes as
      // a deletion (patchStateFile deletes explicit-undefined entries).
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
      dirtyKeys.clear() // nothing pending survives a full wipe
      store.set({})
      try {
        replaceStateFile({})
      } catch (err) {
        console.error("[kobe] kv clear write failed:", err)
      }
    },
  }
}
