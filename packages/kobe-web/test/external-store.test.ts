import { describe, expect, it } from "vitest"
import { createExternalStore } from "../src/lib/external-store.ts"

describe("createExternalStore", () => {
  it("keeps one shared snapshot behind subscribe/get/update/replace", () => {
    const store = createExternalStore({ count: 0 })
    const seen: Array<{ count: number }> = []
    const unsubscribe = store.subscribe(() => {
      seen.push(store.getSnapshot())
    })

    const updated = store.update((snapshot) => ({ count: snapshot.count + 1 }))
    const replaced = store.replace({ count: 7 })

    expect(updated).toEqual({ count: 1 })
    expect(replaced).toEqual({ count: 7 })
    expect(store.getSnapshot()).toEqual({ count: 7 })
    expect(seen).toEqual([{ count: 1 }, { count: 7 }])

    unsubscribe()
    store.replace({ count: 9 })
    expect(seen).toEqual([{ count: 1 }, { count: 7 }])
  })
})
