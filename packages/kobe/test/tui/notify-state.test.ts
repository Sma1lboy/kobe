import { describe, expect, test } from "vitest"

import {
  type NotificationKind,
  TOAST_DURATION_MS,
  addUnread,
  attentionEdges,
  attentionKindFor,
  chipAttentionKind,
  osc9,
  removeUnread,
  shouldShowToast,
  unreadKey,
} from "../../src/tui/lib/notify-state"

const input = (kind: NotificationKind, taskId = "t1", tabId = "c1", extra: { title?: string; body?: string } = {}) => ({
  kind,
  taskId,
  tabId,
  title: extra.title ?? "title",
  ...(extra.body !== undefined ? { body: extra.body } : {}),
})

describe("unreadKey — (task, tab) map key", () => {
  test("joins the two ids so distinct tabs of one task never collide", () => {
    expect(unreadKey("task-1", "tab-a")).toBe("task-1:tab-a")
    expect(unreadKey("task-1", "tab-a")).not.toBe(unreadKey("task-1", "tab-b"))
  })
})

describe("addUnread — escalation into the unread map", () => {
  test("records the kind under the (task, tab) key", () => {
    const next = addUnread(new Map(), input("done"))
    expect(next.get("t1:c1")).toBe("done")
  })

  test("returns a NEW map, leaving the previous one untouched (immutable transform)", () => {
    const prev = new Map<string, NotificationKind>()
    const next = addUnread(prev, input("done"))
    expect(next).not.toBe(prev)
    expect(prev.size).toBe(0)
  })

  test("attention kinds outrank a prior done — yellow/red trump green", () => {
    const done = addUnread(new Map(), input("done"))
    expect(addUnread(done, input("needs_input")).get("t1:c1")).toBe("needs_input")
    expect(addUnread(done, input("error")).get("t1:c1")).toBe("error")
  })

  test("an existing attention mark holds — a later mark never downgrades it, and prev is returned unchanged", () => {
    for (const held of ["needs_input", "error"] as const) {
      const prev = addUnread(new Map(), input(held))
      // done can never overwrite an attention mark…
      expect(addUnread(prev, input("done"))).toBe(prev)
      // …and the top tier is first-write-wins, so even error does not replace
      // a held needs_input (both outrank done; neither outranks the other).
      const next = addUnread(prev, input("error"))
      expect(next).toBe(prev)
      expect(next.get("t1:c1")).toBe(held)
    }
  })

  test("distinct (task, tab) keys accumulate independently", () => {
    let map = addUnread(new Map(), input("done", "t1", "c1"))
    map = addUnread(map, input("error", "t2", "c1"))
    map = addUnread(map, input("done", "t1", "c2"))
    expect(map.get("t1:c1")).toBe("done")
    expect(map.get("t2:c1")).toBe("error")
    expect(map.get("t1:c2")).toBe("done")
    expect(map.size).toBe(3)
  })
})

describe("removeUnread — clearing a mark", () => {
  test("deletes the (task, tab) mark, returning a new map", () => {
    const prev = addUnread(new Map(), input("error"))
    const next = removeUnread(prev, "t1", "c1")
    expect(next.has("t1:c1")).toBe(false)
    expect(next).not.toBe(prev)
    expect(prev.has("t1:c1")).toBe(true)
  })

  test("returns prev unchanged when the key is absent (no needless re-render)", () => {
    const prev = addUnread(new Map(), input("done", "t1", "c1"))
    expect(removeUnread(prev, "t1", "missing")).toBe(prev)
    expect(removeUnread(prev, "other", "c1")).toBe(prev)
  })
})

describe("shouldShowToast — the toast gate", () => {
  test("error always shows, even when the completion toast preference is off", () => {
    expect(shouldShowToast("error", false)).toBe(true)
    expect(shouldShowToast("error", true)).toBe(true)
  })

  test("done and needs_input follow the preference", () => {
    expect(shouldShowToast("done", true)).toBe(true)
    expect(shouldShowToast("done", false)).toBe(false)
    expect(shouldShowToast("needs_input", true)).toBe(true)
    expect(shouldShowToast("needs_input", false)).toBe(false)
  })
})

describe("attentionKindFor — daemon TaskActivityState → notification kind", () => {
  test("maps the ATTENTION_INBOX_STATES to their colors", () => {
    expect(attentionKindFor("permission_needed")).toBe("needs_input")
    expect(attentionKindFor("error")).toBe("error")
    expect(attentionKindFor("rate_limited")).toBe("error")
    expect(attentionKindFor("turn_complete")).toBe("done")
  })

  test("every other state is not an attention edge", () => {
    for (const s of ["idle", "running", "unknown", "", "permission", "complete"]) {
      expect(attentionKindFor(s)).toBeNull()
    }
  })
})

describe("chipAttentionKind — ChatTabTurnState → notification kind", () => {
  test("done/error/needs_input notify; idle/running/unknown do not", () => {
    expect(chipAttentionKind("done")).toBe("done")
    expect(chipAttentionKind("error")).toBe("error")
    expect(chipAttentionKind("needs_input")).toBe("needs_input")
    for (const s of ["idle", "running", "unknown", "", "turn_complete"]) {
      expect(chipAttentionKind(s)).toBeNull()
    }
  })
})

describe("attentionEdges — the shared rising-edge detector", () => {
  const kindFor = attentionKindFor

  test("seed rule: prev === null never fires, so replayed sticky history is not re-toasted", () => {
    const next = new Map([["a", "turn_complete"]])
    expect(attentionEdges(null, next, null, kindFor)).toEqual([])
  })

  test("a fresh transition INTO an attention state fires once", () => {
    const prev = new Map([["a", "running"]])
    const next = new Map([["a", "turn_complete"]])
    expect(attentionEdges(prev, next, null, kindFor)).toEqual([{ key: "a", kind: "done" }])
  })

  test("an unchanged value is not an edge — a still-attention state does not re-fire", () => {
    const prev = new Map([["a", "turn_complete"]])
    const next = new Map([["a", "turn_complete"]])
    expect(attentionEdges(prev, next, null, kindFor)).toEqual([])
  })

  test("a key absent from prev counts as a transition (seed map may omit new keys)", () => {
    const prev = new Map<string, string>()
    const next = new Map([["a", "permission_needed"]])
    expect(attentionEdges(prev, next, null, kindFor)).toEqual([{ key: "a", kind: "needs_input" }])
  })

  test("skip excludes the on-screen key — the disjointness that prevents double-toasting", () => {
    const prev = new Map([["sel", "running"]])
    const next = new Map([["sel", "error"]])
    expect(attentionEdges(prev, next, "sel", kindFor)).toEqual([])
  })

  test("a transition into a non-attention state is dropped by kindFor", () => {
    const prev = new Map([["a", "turn_complete"]])
    const next = new Map([["a", "running"]])
    expect(attentionEdges(prev, next, null, kindFor)).toEqual([])
  })

  test("reports every attention edge across many keys, skipping only the one on screen", () => {
    const prev = new Map([
      ["a", "running"],
      ["b", "running"],
      ["c", "running"],
    ])
    const next = new Map([
      ["a", "turn_complete"],
      ["b", "error"],
      ["c", "permission_needed"],
    ])
    expect(attentionEdges(prev, next, "b", kindFor)).toEqual([
      { key: "a", kind: "done" },
      { key: "c", kind: "needs_input" },
    ])
  })
})

describe("osc9 — the OSC 9 desktop-notification escape", () => {
  const ESC = String.fromCharCode(0x1b)
  const BEL = String.fromCharCode(0x07)
  const wrap = (body: string) => `${ESC}]9;${body}${BEL}`

  test("wraps a clean body in the OSC 9 introducer and BEL terminator", () => {
    expect(osc9("Task done")).toBe(wrap("Task done"))
  })

  test("strips control chars that would break the escape, replacing each with a space", () => {
    // An embedded BEL would terminate the OSC early; an ESC would start a new
    // control sequence. Neither may survive into the body.
    expect(osc9(`done${BEL}now`)).toBe(wrap("done now"))
    expect(osc9(`a${ESC}b`)).toBe(wrap("a b"))
  })

  test("strips the full C0 + DEL + C1 control range, one space per control", () => {
    const controls = String.fromCharCode(0x00, 0x1f, 0x7f, 0x80, 0x9f)
    expect(osc9(`x${controls}y`)).toBe(wrap("x     y"))
  })

  test("keeps the printables that straddle the stripped ranges — 0x20 and 0xa0", () => {
    // 0x20 (space) is the first printable after the C0 range; 0xa0 (NBSP) is
    // the first printable past the C1 range — the byte one step above a
    // stripped control must survive untouched.
    const nbsp = String.fromCharCode(0xa0)
    expect(osc9(`~ ${nbsp}!`)).toBe(wrap(`~ ${nbsp}!`))
  })

  test("passes multi-byte and astral text through — surrogate halves are never stripped", () => {
    // Each surrogate unit is > 0x9f, so a CJK glyph or emoji travels intact.
    expect(osc9("完成 🎉")).toBe(wrap("完成 🎉"))
  })
})

describe("TOAST_DURATION_MS", () => {
  test("is a positive dwell time both providers share", () => {
    expect(TOAST_DURATION_MS).toBeGreaterThan(0)
    expect(TOAST_DURATION_MS).toBe(4500)
  })
})
