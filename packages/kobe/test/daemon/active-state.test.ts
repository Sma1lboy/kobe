import { describe, expect, it } from "vitest"
import { createActiveState } from "../../src/daemon/active-state.ts"

describe("createActiveState", () => {
  it("starts null by default and reports via get()", () => {
    const s = createActiveState()
    expect(s.get()).toBeNull()
  })

  it("accepts an initial id", () => {
    const s = createActiveState("t1")
    expect(s.get()).toBe("t1")
  })

  it("set() updates and notifies listeners", () => {
    const s = createActiveState()
    const seen: Array<string | null> = []
    s.onChange((id) => seen.push(id))
    s.set("t1")
    s.set("t2")
    s.set(null)
    expect(s.get()).toBeNull()
    expect(seen).toEqual(["t1", "t2", null])
  })

  it("set() is a no-op when the id is already current (no broadcast)", () => {
    const s = createActiveState("t1")
    let count = 0
    s.onChange(() => count++)
    s.set("t1")
    s.set("t1")
    expect(count).toBe(0)
  })

  it("next() cycles forward through the passed task-id array", () => {
    const s = createActiveState("a")
    s.next(["a", "b", "c"])
    expect(s.get()).toBe("b")
    s.next(["a", "b", "c"])
    expect(s.get()).toBe("c")
    s.next(["a", "b", "c"])
    expect(s.get()).toBe("a")
  })

  it("prev() cycles backward through the passed task-id array", () => {
    const s = createActiveState("a")
    s.prev(["a", "b", "c"])
    expect(s.get()).toBe("c")
    s.prev(["a", "b", "c"])
    expect(s.get()).toBe("b")
    s.prev(["a", "b", "c"])
    expect(s.get()).toBe("a")
  })

  it("next()/prev() with no current id jumps to the first/last entry", () => {
    const s1 = createActiveState()
    s1.next(["a", "b", "c"])
    expect(s1.get()).toBe("a")
    const s2 = createActiveState()
    s2.prev(["a", "b", "c"])
    expect(s2.get()).toBe("c")
  })

  it("next()/prev() are no-ops when the task list is empty", () => {
    const s = createActiveState("a")
    let count = 0
    s.onChange(() => count++)
    s.next([])
    s.prev([])
    expect(s.get()).toBe("a")
    expect(count).toBe(0)
  })

  it("next() with a current id NOT in the list jumps to the first entry", () => {
    const s = createActiveState("gone")
    s.next(["a", "b"])
    expect(s.get()).toBe("a")
  })

  it("prev() with a current id NOT in the list jumps to the last entry", () => {
    const s = createActiveState("gone")
    s.prev(["a", "b"])
    expect(s.get()).toBe("b")
  })

  it("onChange() returns an unsubscribe handle", () => {
    const s = createActiveState()
    let count = 0
    const unsub = s.onChange(() => count++)
    s.set("a")
    unsub()
    s.set("b")
    expect(count).toBe(1)
  })
})
