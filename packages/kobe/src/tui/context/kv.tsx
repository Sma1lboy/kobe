/**
 * KV store — disk-backed JSON at `~/.config/kobe/state.json`, or
 * `$KOBE_HOME_DIR/.config/kobe/state.json` in isolated test/dev homes.
 *
 * Surface mirrors opencode's `useKV` (`get`, `set`, `signal`). Reads are
 * synchronous: the file is small (a few keys) and we want hydration done
 * before the first render so consumers can `kv.signal(name, default)` and
 * see the persisted value immediately rather than the default flashing
 * for one frame. Reads are also deliberately snapshot-only — a key another
 * process writes after this provider booted is not picked up until
 * restart. No file watching; that's longstanding, accepted behavior.
 *
 * Writes are debounced (250ms) and routed through `src/state/store.ts`,
 * which owns all state.json I/O (atomic tmp+rename — a crash mid-write
 * can't leave a half-written file). Writes are per-key, never a whole
 * in-memory snapshot: with several kobe processes alive at once, a
 * whole-snapshot flush silently reverts any key another process wrote
 * since this one loaded — the classic lost update.
 * The fix is dirty-key tracking: we remember which keys THIS process
 * changed since its last successful flush and merge only those into a
 * fresh read of the file (`patchStateFile`). Keys we never touched pass
 * through whatever the other processes wrote.
 */

import type { Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { loadStateFile, patchStateFile, replaceStateFile } from "../../state/store.ts"
import { createSimpleContext } from "./helper"

const WRITE_DEBOUNCE_MS = 250

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [store, setStore] = createStore<Record<string, unknown>>(loadStateFile())

    /**
     * Keys this process has `set()` since the last successful flush. Only
     * these are written back — the rest of the in-memory snapshot is for
     * reads only and must never reach disk (that's the lost-update bug).
     * Kept across a failed flush so the change retries on the next one.
     */
    const dirtyKeys = new Set<string>()

    let writeTimer: ReturnType<typeof setTimeout> | null = null
    function writeNow(label: string): boolean {
      if (dirtyKeys.size === 0) return true // nothing of ours to merge
      try {
        // Read-merge-write: only OUR dirty keys are applied onto a fresh
        // read of the file. A key set to `undefined` locally serializes
        // as a deletion, matching the old stringify-drops-undefined
        // behavior.
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
      /**
       * Synchronously flush pending state. Standalone pages call this
       * before process.exit(), where the normal debounced write may not
       * get a chance to run.
       */
      flush(): boolean {
        if (writeTimer) {
          clearTimeout(writeTimer)
          writeTimer = null
        }
        return writeNow("flush")
      },
      /**
       * Wipe every persisted key and synchronously flush the now-empty
       * store to disk. Used by the Dev settings panel's "reset UI
       * state" affordance.
       *
       * The write MUST be synchronous (not the usual debounce): the
       * caller exits the kobe process immediately after — without an
       * eager flush, the 250ms timer is racy against any stray
       * `kv.set` from a persistence effect that fires before exit, and
       * the on-disk file ends up partially repopulated. We also can't
       * rely on the in-memory Solid signals being reset, since `clear`
       * only knows about KV keys; the post-reset relaunch is what
       * brings the rest of the UI back to defaults.
       *
       * This is the one legitimate whole-file write (`replaceStateFile`):
       * "reset UI state" means wipe EVERYTHING, including keys other
       * processes wrote after we loaded — a dirty-key merge would
       * preserve exactly the state the user asked to destroy.
       */
      clear() {
        for (const k of Object.keys(store)) setStore(k, undefined as unknown)
        if (writeTimer) {
          clearTimeout(writeTimer)
          writeTimer = null
        }
        dirtyKeys.clear() // nothing pending survives a full wipe
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
