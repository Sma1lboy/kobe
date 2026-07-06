/** @jsxImportSource @opentui/react */
/**
 * KV store provider — React port of `src/tui/context/kv.tsx` (issue #15,
 * G3). Persistence semantics (snapshot hydration, dirty-key merge flush,
 * whole-file clear) live in the framework-free `./kv-core`; this file owns
 * only the React reactivity: the provider subscribes to the core via
 * `useSyncExternalStore` and rebuilds the context value per snapshot, so
 * every consumer under the provider re-renders on any `kv.set`.
 *
 * API parity with the Solid provider: `ready` / `store` / `signal` / `get`
 * / `set` / `flush` / `clear`. Delta by design: `signal` returns a plain
 * `[read, write]` tuple (Solid's `Setter` overload has no React
 * equivalent), and `store` is the immutable snapshot rather than a
 * fine-grained proxy.
 */

import { type ReactNode, createContext, useContext, useMemo, useState, useSyncExternalStore } from "react"
import { type KvCore, createKvCore } from "./kv-core"

export type KVContext = {
  readonly ready: boolean
  readonly store: Record<string, unknown>
  signal<T>(name: string, defaultValue: T): readonly [() => T, (next: T) => void]
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
  /** Synchronously flush pending state (standalone pages, before exit). */
  flush(): boolean
  /** Wipe every persisted key and write the empty file (Dev → reset). */
  clear(): void
}

const Ctx = createContext<KVContext | null>(null)

export function KVProvider(props: { children?: ReactNode }) {
  // One core per provider instance, hydrated synchronously at first render
  // (mirrors the Solid provider's init-time loadStateFile()).
  const [core] = useState<KvCore>(createKvCore)
  const snapshot = useSyncExternalStore(core.subscribe, core.snapshot, core.snapshot)

  const value = useMemo<KVContext>(
    () => ({
      ready: true,
      store: snapshot,
      signal<T>(name: string, defaultValue: T) {
        core.seed(name, defaultValue)
        return [() => (core.get(name) ?? defaultValue) as T, (next: T) => core.set(name, next)] as const
      },
      get: core.get,
      set: core.set,
      flush: core.flush,
      clear: core.clear,
    }),
    [core, snapshot],
  )

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export function useKV(): KVContext {
  const value = useContext(Ctx)
  if (!value) throw new Error("KV context must be used within a context provider")
  return value
}
