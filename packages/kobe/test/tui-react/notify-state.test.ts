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
  attentionEdges,
  attentionKindFor,
  chipAttentionKind,
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
  it("maps every Inbox-episode transition and ignores the rest", () => {
    expect(attentionKindFor("permission_needed")).toBe("needs_input")
    expect(attentionKindFor("error")).toBe("error")
    expect(attentionKindFor("turn_complete")).toBe("done")
    // rate_limited is an ATTENTION_INBOX_STATE — a non-selected task that hits
    // it becomes a pending Inbox episode, so it MUST announce itself. It maps
    // to "error" (red) like the per-tab chip notifier (activityTurnState),
    // keeping the two notifiers symmetric instead of silently dropping it.
    expect(attentionKindFor("rate_limited")).toBe("error")
    expect(attentionKindFor("running")).toBeNull()
    expect(attentionKindFor("idle")).toBeNull()
  })
})

describe("chipAttentionKind", () => {
  it("maps the chip vocabulary's attention states and ignores the rest", () => {
    expect(chipAttentionKind("done")).toBe("done")
    expect(chipAttentionKind("error")).toBe("error")
    expect(chipAttentionKind("needs_input")).toBe("needs_input")
    expect(chipAttentionKind("running")).toBeNull()
    expect(chipAttentionKind("idle")).toBeNull()
    expect(chipAttentionKind("unknown")).toBeNull()
  })
})

describe("attentionEdges", () => {
  // The seed rule is the replay-safety requirement: a fresh subscriber's
  // replayed sticky turn_complete may paint the ✓ chip but must NEVER
  // re-fire a toast — prev===null means "seed only, no notifications".
  it("returns nothing on the seed observation (prev === null)", () => {
    const next = new Map([["tab-1", "done"]])
    expect(attentionEdges(null, next, null, chipAttentionKind)).toEqual([])
  })

  it("fires only on a transition INTO an attention state", () => {
    const prev = new Map([["tab-1", "running"]])
    const next = new Map([["tab-1", "done"]])
    expect(attentionEdges(prev, next, null, chipAttentionKind)).toEqual([{ key: "tab-1", kind: "done" }])
    // Unchanged value — no edge, no repeat toast.
    expect(attentionEdges(next, next, null, chipAttentionKind)).toEqual([])
  })

  it("skips the on-screen key (active tab / selected task)", () => {
    const prev = new Map([
      ["tab-1", "running"],
      ["tab-2", "running"],
    ])
    const next = new Map([
      ["tab-1", "done"],
      ["tab-2", "needs_input"],
    ])
    expect(attentionEdges(prev, next, "tab-1", chipAttentionKind)).toEqual([{ key: "tab-2", kind: "needs_input" }])
  })

  it("works with the task-level kind mapper too", () => {
    const prev = new Map([["task-a", "running"]])
    const next = new Map([["task-a", "permission_needed"]])
    expect(attentionEdges(prev, next, null, attentionKindFor)).toEqual([{ key: "task-a", kind: "needs_input" }])
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
