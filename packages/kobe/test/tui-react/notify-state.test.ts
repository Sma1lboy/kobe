/**
 * Invariants for the shared notification state (issue #15, G3) — the pure
 * transforms behind BOTH the Solid and React NotificationsProviders. The
 * escalation rule (needs_input/error outrank done) and the "error toasts
 * always show" gate are behavior users notice the moment they regress
 * (a red unread dot silently downgraded to green, or a failure toast
 * suppressed by the completion-toast preference), so they're pinned here
 * framework-free.
 */

import { describe, expect, it } from "vitest"
import {
  addUnread,
  attentionKindFor,
  nextAttentionTask,
  osc9,
  removeUnread,
  shouldShowToast,
  unreadKey,
} from "../../src/tui/lib/notify-state"

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
    // done must NOT downgrade an attention-demanding mark…
    const after = addUnread(map, input("done"))
    expect(after).toBe(map) // same reference — untouched
    // …and error is equally sticky.
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
    // Error toasts are failure feedback — disabling the completion-toast
    // preference must never silence them (silent-failure regression).
    expect(shouldShowToast("error", false)).toBe(true)
  })
})

describe("attentionKindFor", () => {
  it("maps the three attention transitions and ignores the rest", () => {
    expect(attentionKindFor("permission_needed")).toBe("needs_input")
    expect(attentionKindFor("error")).toBe("error")
    expect(attentionKindFor("turn_complete")).toBe("done")
    expect(attentionKindFor("running")).toBeNull()
    expect(attentionKindFor("idle")).toBeNull()
  })
})

describe("osc9", () => {
  it("wraps the body in the OSC 9 escape with a BEL terminator", () => {
    expect(osc9("kobe — hi")).toBe("\x1b]9;kobe — hi\x07")
  })
})

describe("nextAttentionTask", () => {
  const es = (m: Record<string, string>): Map<string, { state: string }> =>
    new Map(Object.entries(m).map(([id, state]) => [id, { state }]))

  it("finds the next permission_needed/error task forward from current, wrapping", () => {
    const order = ["a", "b", "c", "d"]
    const engine = es({ a: "running", b: "permission_needed", c: "idle", d: "error" })
    // from a → next waiting is b
    expect(nextAttentionTask(order, engine, new Map(), "a")).toBe("b")
    // from b → wraps past c (idle) to d
    expect(nextAttentionTask(order, engine, new Map(), "b")).toBe("d")
    // from d → wraps back to b
    expect(nextAttentionTask(order, engine, new Map(), "d")).toBe("b")
  })

  it("counts an unread needs_input/error mark as attention, but not a done mark", () => {
    const order = ["a", "b"]
    const idle = es({ a: "idle", b: "idle" })
    expect(nextAttentionTask(order, idle, new Map([["b:tab", "needs_input"]]), "a")).toBe("b")
    // a plain `done` unread is not blocking → no candidate
    expect(nextAttentionTask(order, idle, new Map([["b:tab", "done"]]), "a")).toBeNull()
  })

  it("returns null when nothing needs attention", () => {
    expect(nextAttentionTask(["a", "b"], es({ a: "running", b: "idle" }), new Map(), "a")).toBeNull()
  })

  it("handles a null/unknown current id by scanning from the start", () => {
    const order = ["a", "b"]
    const engine = es({ a: "error", b: "idle" })
    expect(nextAttentionTask(order, engine, new Map(), null)).toBe("a")
    expect(nextAttentionTask(order, engine, new Map(), "gone")).toBe("a")
  })
})
