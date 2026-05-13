/**
 * KV store — disk-backed JSON at `~/.config/kobe/state.json`, or
 * `$KOBE_HOME_DIR/.config/kobe/state.json` in isolated test/dev homes.
 *
 * Surface mirrors opencode's `useKV` (`get`, `set`, `signal`). Reads are
 * synchronous: the file is small (a few keys) and we want hydration done
 * before the first render so consumers can `kv.signal(name, default)` and
 * see the persisted value immediately rather than the default flashing
 * for one frame.
 *
 * Writes are debounced and atomic (write to `state.json.tmp`, then rename)
 * so a crash mid-write can't leave a half-written file. No flock yet — we
 * assume a single kobe instance per user; multi-instance is a Wave-2
 * concern when it arrives.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { kvStatePath } from "../../env.ts"
import { createSimpleContext } from "./helper"

const WRITE_DEBOUNCE_MS = 250

function loadInitial(): Record<string, unknown> {
  const statePath = kvStatePath()
  try {
    const text = readFileSync(statePath, "utf8")
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Missing file or malformed JSON: start fresh. We don't surface the
    // error — a corrupt state file shouldn't block the UI.
  }
  return {}
}

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [store, setStore] = createStore<Record<string, unknown>>(loadInitial())

    let writeTimer: ReturnType<typeof setTimeout> | null = null
    function scheduleWrite(): void {
      if (writeTimer) clearTimeout(writeTimer)
      writeTimer = setTimeout(() => {
        writeTimer = null
        const statePath = kvStatePath()
        try {
          mkdirSync(dirname(statePath), { recursive: true })
          const tmp = `${statePath}.tmp`
          writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8")
          renameSync(tmp, statePath)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[kobe] kv write failed:", err)
        }
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
        scheduleWrite()
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
       */
      clear() {
        for (const k of Object.keys(store)) setStore(k, undefined as unknown)
        if (writeTimer) {
          clearTimeout(writeTimer)
          writeTimer = null
        }
        const statePath = kvStatePath()
        try {
          mkdirSync(dirname(statePath), { recursive: true })
          const tmp = `${statePath}.tmp`
          writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8")
          renameSync(tmp, statePath)
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
