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
  nextAttentionTarget,
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

  it("neutralizes terminal control bytes before framing the notification", () => {
    const injected = "safe\x07\x1b]52;c;Y2xpcGJvYXJk\x07\x9d9;again\x9c\nend"
    const framed = osc9(injected)

    expect(framed).toBe("\x1b]9;safe  ]52;c;Y2xpcGJvYXJk  9;again  end\x07")
  })

  it("neutralizes every C0 and C1 control byte", () => {
    const controls = String.fromCharCode(...Array.from({ length: 0x20 }, (_, code) => code), 0x7f)
    const c1 = String.fromCharCode(...Array.from({ length: 0x20 }, (_, offset) => 0x80 + offset))
    expect(osc9(`${controls}${c1}`)).toBe(`\x1b]9;${" ".repeat(0x41)}\x07`)
  })
})

describe("nextAttentionTarget", () => {
  const es = (m: Record<string, string>): Map<string, { state: string }> =>
    new Map(Object.entries(m).map(([id, state]) => [id, { state }]))
  const ts = (m: Record<string, Record<string, string>>): Map<string, Map<string, { state: string }>> =>
    new Map(Object.entries(m).map(([taskId, tabs]) => [taskId, es(tabs)]))
  const NO_TABS = new Map<string, Map<string, { state: string }>>()
  const at = (taskId: string | null, tabId: string | null = null) => ({ taskId, tabId })

  it("finds the next permission_needed/error task forward from current, wrapping", () => {
    const order = ["a", "b", "c", "d"]
    const engine = es({ a: "running", b: "permission_needed", c: "idle", d: "error" })
    expect(nextAttentionTarget(order, engine, NO_TABS, new Map(), at("a"))).toEqual({ taskId: "b", tabId: null })
    expect(nextAttentionTarget(order, engine, NO_TABS, new Map(), at("b"))).toEqual({ taskId: "d", tabId: null })
    expect(nextAttentionTarget(order, engine, NO_TABS, new Map(), at("d"))).toEqual({ taskId: "b", tabId: null })
  })

  it("counts unread needs_input/error AND done marks (turn_complete is navigable)", () => {
    const order = ["a", "b"]
    const idle = es({ a: "idle", b: "idle" })
    expect(nextAttentionTarget(order, idle, NO_TABS, new Map([["b:tab-2", "needs_input"]]), at("a"))).toEqual({
      taskId: "b",
      tabId: "tab-2",
    })
    // A `done` unread IS a candidate now (owner call 2026-07-12): F7 means
    // "next thing that needs my eyes", and marking read on arrival keeps the
    // cycle advancing instead of looping.
    expect(nextAttentionTarget(order, idle, NO_TABS, new Map([["b:", "done"]]), at("a"))).toEqual({
      taskId: "b",
      tabId: null,
    })
  })

  it("walks the CURRENT task's other waiting tabs before other tasks", () => {
    const order = ["a", "b"]
    const engine = es({ a: "permission_needed", b: "permission_needed" })
    const tabs = ts({ a: { "tab-1": "permission_needed", "tab-3": "permission_needed" }, b: {} })
    // Sitting on a's tab-1: its own waiting tab-3 comes before task b.
    expect(nextAttentionTarget(order, engine, tabs, new Map(), at("a", "tab-1"))).toEqual({
      taskId: "a",
      tabId: "tab-3",
    })
    // From a's tab-3 the cycle moves on to b.
    expect(nextAttentionTarget(order, engine, tabs, new Map(), at("a", "tab-3"))).toEqual({
      taskId: "a",
      tabId: "tab-1",
    })
  })

  it("refines a task-level hit to the tab the per-tab map knows is waiting", () => {
    const order = ["a", "b"]
    const engine = es({ a: "idle", b: "turn_complete" })
    const tabs = ts({ b: { "tab-2": "turn_complete" } })
    // b qualifies via its unread done mark; the per-tab map points at tab-2.
    expect(nextAttentionTarget(order, engine, tabs, new Map([["b:", "done"]]), at("a"))).toEqual({
      taskId: "b",
      tabId: "tab-2",
    })
    // Raw turn_complete alone (mark already cleared) is NOT a candidacy
    // source — otherwise a visited completion would cycle forever.
    expect(nextAttentionTarget(order, engine, tabs, new Map(), at("a"))).toBeNull()
  })

  it("skips a task-level self-target but keeps blocking states cycling", () => {
    const order = ["a"]
    const engine = es({ a: "permission_needed" })
    // Alone on the blocked task with no tab info: nothing to jump to.
    expect(nextAttentionTarget(order, engine, NO_TABS, new Map(), at("a"))).toBeNull()
  })

  it("returns null when nothing needs attention", () => {
    expect(nextAttentionTarget(["a", "b"], es({ a: "running", b: "idle" }), NO_TABS, new Map(), at("a"))).toBeNull()
  })

  it("handles a null/unknown current id by scanning from the start", () => {
    const order = ["a", "b"]
    const engine = es({ a: "error", b: "idle" })
    expect(nextAttentionTarget(order, engine, NO_TABS, new Map(), at(null))).toEqual({ taskId: "a", tabId: null })
    expect(nextAttentionTarget(order, engine, NO_TABS, new Map(), at("gone"))).toEqual({ taskId: "a", tabId: null })
  })
})
