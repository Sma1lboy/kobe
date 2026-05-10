/**
 * KV store — disk-backed JSON at `~/.config/kobe/state.json`.
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
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"

const STATE_PATH = join(homedir(), ".config", "kobe", "state.json")
const WRITE_DEBOUNCE_MS = 250

function loadInitial(): Record<string, unknown> {
  try {
    const text = readFileSync(STATE_PATH, "utf8")
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
        try {
          mkdirSync(dirname(STATE_PATH), { recursive: true })
          const tmp = `${STATE_PATH}.tmp`
          writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8")
          renameSync(tmp, STATE_PATH)
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
       * Wipe every persisted key and immediately schedule a write of
       * the now-empty store. Used by the Dev settings panel's "reset
       * UI state" affordance — drops persisted task selection, center
       * tabs, pane sizes, etc., reverting kobe to a fresh-launch
       * layout without touching `~/.kobe/tasks.json`.
       */
      clear() {
        for (const k of Object.keys(store)) setStore(k, undefined as unknown)
        scheduleWrite()
      },
    }
    return result
  },
})

export type KVContext = ReturnType<typeof useKV>
