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
