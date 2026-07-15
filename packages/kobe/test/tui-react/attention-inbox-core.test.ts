import { describe, expect, test } from "vitest"
import type { AttentionInboxItem } from "../../src/client/remote-orchestrator"
import {
  attentionInboxKey,
  isAttentionInboxItemAvailable,
  nextAttentionInboxTarget,
  sortAttentionInbox,
} from "../../src/tui-react/workspace/attention-inbox-core"

const item = (
  taskId: string,
  tabId: string | null,
  state: AttentionInboxItem["state"],
  at: number,
): AttentionInboxItem => ({ taskId, tabId, state, unread: true, at })

describe("attention inbox ordering", () => {
  test("puts every unread episode before retained read episodes", () => {
    const readPermission = { ...item("a", "tab-1", "permission_needed", 1), unread: false }
    const unreadCompletion = item("b", "tab-1", "turn_complete", 2)
    expect(sortAttentionInbox([readPermission, unreadCompletion], ["a", "b"])).toEqual([
      unreadCompletion,
      readPermission,
    ])
  })

  test("prioritizes input and failures over completions, then oldest first", () => {
    const ordered = sortAttentionInbox(
      [
        item("b", "tab-1", "turn_complete", 10),
        item("a", "tab-2", "error", 9),
        item("a", "tab-1", "permission_needed", 11),
        item("b", "tab-2", "rate_limited", 8),
      ],
      ["a", "b"],
    )
    expect(ordered.map(attentionInboxKey)).toEqual(["a\u0000tab-1", "b\u0000tab-2", "a\u0000tab-2", "b\u0000tab-1"])
  })

  test("F7 cycles only unread task and chat-tab episodes without removing them", () => {
    const read = { ...item("c", "tab-3", "permission_needed", 7), unread: false }
    const items = [read, item("a", "tab-1", "error", 8), item("b", "tab-2", "turn_complete", 9)]
    const target = nextAttentionInboxTarget(items, ["a", "b"], { taskId: "a", tabId: "tab-1" })
    expect(target?.taskId).toBe("b")
    expect(items).toHaveLength(3)
  })

  test("returns the only current unread episode so F7 can mark it read", () => {
    const items = [item("a", "tab-1", "error", 8)]
    expect(nextAttentionInboxTarget(items, ["a"], { taskId: "a", tabId: "tab-1" })).toBe(items[0])
  })

  test("returns null when every retained episode has already been read", () => {
    const read = { ...item("a", "tab-1", "error", 8), unread: false }
    expect(nextAttentionInboxTarget([read], ["a"], { taskId: null, tabId: null })).toBeNull()
  })

  test("retains unavailable task episodes in the sorted list but skips them for F7", () => {
    const missing = item("deleted", null, "error", 8)
    const live = item("live", null, "turn_complete", 9)
    expect(sortAttentionInbox([missing, live], ["live"])).toContain(missing)
    expect(nextAttentionInboxTarget([missing, live], ["live"], { taskId: null, tabId: null })).toBe(live)
  })

  test("skips a retained episode whose chat tab has closed", () => {
    const closed = item("live", "closed", "error", 8)
    const open = item("live", "open", "turn_complete", 9)
    expect(
      nextAttentionInboxTarget(
        [closed, open],
        ["live"],
        { taskId: null, tabId: null },
        (candidate) => candidate.tabId === "open",
      ),
    ).toBe(open)
  })

  test("uses one availability rule for archived tasks and closed tabs", () => {
    const open = item("live", "open", "error", 8)
    expect(isAttentionInboxItemAvailable(open, { archived: false }, (id) => id === "open")).toBe(true)
    expect(isAttentionInboxItemAvailable(open, { archived: true }, () => true)).toBe(false)
    expect(isAttentionInboxItemAvailable(open, { archived: false }, () => false)).toBe(false)
  })
})
