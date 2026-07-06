/** @jsxImportSource @opentui/react */

import { type ReactNode, createContext, useContext, useMemo, useState, useSyncExternalStore } from "react"
import { type KvCore, createKvCore } from "./kv-core"

export type KVContext = {
  readonly ready: boolean
  readonly store: Record<string, unknown>
  signal<T>(name: string, defaultValue: T): readonly [() => T, (next: T) => void]
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
  flush(): boolean
  clear(): void
}

const Ctx = createContext<KVContext | null>(null)

export function KVProvider(props: { children?: ReactNode }) {
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
