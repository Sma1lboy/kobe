import { describe, expect, it } from "vitest"
import { addUnread, removeUnread, shouldShowToast, unreadKey } from "../../src/tui/lib/notify-state"

const input = (kind: "done" | "needs_input" | "error", tabId = "tab-1") =>
  ({ kind, taskId: "task-1", tabId, title: "t" }) as const

describe("addUnread", () => {
  it("marks a fresh (task, tab) and keys it as task:tab", () => {
    const next = addUnread(new Map(), input("done"))
    expect(next.get(unreadKey("task-1", "tab-1"))).toBe("done")
  })

  it("lets needs_input/error overwrite done, never the reverse", () => {
    let map = addUnread(new Map(), input("done"))
    map = addUnread(map, input("needs_input"))
    expect(map.get("task-1:tab-1")).toBe("needs_input")
    const after = addUnread(map, input("done"))
    expect(after).toBe(map)
    let errMap = addUnread(new Map(), input("error"))
    errMap = addUnread(errMap, input("needs_input"))
    expect(errMap.get("task-1:tab-1")).toBe("error")
  })

  it("tracks tabs independently", () => {
    let map = addUnread(new Map(), input("done", "tab-1"))
    map = addUnread(map, input("error", "tab-2"))
    expect(map.size).toBe(2)
    expect(map.get("task-1:tab-2")).toBe("error")
  })
})

describe("removeUnread", () => {
  it("clears only the given (task, tab) and no-ops (same ref) when absent", () => {
    let map = addUnread(new Map(), input("done", "tab-1"))
    map = addUnread(map, input("done", "tab-2"))
    const cleared = removeUnread(map, "task-1", "tab-1")
    expect(cleared.has("task-1:tab-1")).toBe(false)
    expect(cleared.has("task-1:tab-2")).toBe(true)
    expect(removeUnread(cleared, "task-1", "tab-1")).toBe(cleared)
  })
})

describe("shouldShowToast", () => {
  it("respects the toggle for done/needs_input but always shows errors", () => {
    expect(shouldShowToast("done", true)).toBe(true)
    expect(shouldShowToast("done", false)).toBe(false)
    expect(shouldShowToast("needs_input", false)).toBe(false)
    expect(shouldShowToast("error", false)).toBe(true)
  })
})
