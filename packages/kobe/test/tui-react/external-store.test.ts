/**
 * Why this matters: `createExternalStore` is the reactive backbone of every
 * React infra module (i18n language, theme state, keymap version). A bug in
 * notify/dedupe semantics would silently freeze React panes on stale
 * language/theme — the exact failure `useSyncExternalStore` is supposed to
 * prevent — so the contract is pinned here framework-free.
 */

import { describe, expect, it, vi } from "vitest"
import { createExternalStore } from "../../src/lib/external-store"

describe("createExternalStore", () => {
  it("get returns the current snapshot; set replaces it", () => {
    const store = createExternalStore({ n: 1 })
    expect(store.get()).toEqual({ n: 1 })
    store.set({ n: 2 })
    expect(store.get()).toEqual({ n: 2 })
  })

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const store = createExternalStore(0)
    const seen: number[] = []
    const unsub = store.subscribe(() => seen.push(store.get()))
    store.set(1)
    store.set(2)
    unsub()
    store.set(3)
    expect(seen).toEqual([1, 2])
  })

  it("dedupes identical snapshots (Object.is) — no phantom notifications", () => {
    const store = createExternalStore("a")
    const listener = vi.fn()
    store.subscribe(listener)
    store.set("a")
    expect(listener).not.toHaveBeenCalled()
    store.set("b")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("update applies a functional transform over the current snapshot", () => {
    const store = createExternalStore({ count: 1 })
    store.update((s) => ({ count: s.count + 1 }))
    expect(store.get()).toEqual({ count: 2 })
  })

  it("a listener unsubscribing during notify does not skip other listeners", () => {
    const store = createExternalStore(0)
    const seen: string[] = []
    const unsubA = store.subscribe(() => {
      seen.push("a")
      unsubA()
    })
    store.subscribe(() => seen.push("b"))
    store.set(1)
    store.set(2)
    expect(seen).toEqual(["a", "b", "b"])
  })
})
