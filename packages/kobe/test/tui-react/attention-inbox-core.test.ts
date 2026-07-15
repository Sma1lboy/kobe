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
): AttentionInboxItem => ({ taskId, tabId, state, at })

describe("attention inbox ordering", () => {
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

  test("F7 cycles task and chat-tab episodes without removing them", () => {
    const items = [item("a", "tab-1", "error", 8), item("b", "tab-2", "turn_complete", 9)]
    const target = nextAttentionInboxTarget(items, ["a", "b"], { taskId: "a", tabId: "tab-1" })
    expect(target?.taskId).toBe("b")
    expect(items).toHaveLength(2)
  })

  test("does not pretend the only current episode is a new target", () => {
    const items = [item("a", "tab-1", "error", 8)]
    expect(nextAttentionInboxTarget(items, ["a"], { taskId: "a", tabId: "tab-1" })).toBeNull()
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
