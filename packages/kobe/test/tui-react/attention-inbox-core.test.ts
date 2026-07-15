import { describe, expect, test } from "vitest"
import type { AttentionInboxItem } from "../../src/client/remote-orchestrator"
import {
  attentionInboxCounts,
  attentionInboxKey,
  groupAttentionInbox,
  isAttentionInboxItemAvailable,
  nextAttentionInboxTarget,
  sortAttentionInbox,
} from "../../src/tui-react/workspace/attention-inbox-core"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"

const item = (
  taskId: string,
  tabId: string | null,
  state: AttentionInboxItem["state"],
  at: number,
): AttentionInboxItem => ({ taskId, tabId, state, unread: true, at })

const task = (id: string, repo: string): Task => ({
  id: toTaskId(id),
  title: id,
  repo,
  branch: id,
  worktreePath: `/tmp/${id}`,
  status: "in_progress",
  archived: false,
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
})

describe("attention inbox ordering", () => {
  test("counts retained episodes separately from unread episodes", () => {
    expect(
      attentionInboxCounts([item("a", null, "error", 1), { ...item("b", null, "turn_complete", 2), unread: false }]),
    ).toEqual({
      total: 2,
      unread: 1,
    })
    expect(attentionInboxCounts([])).toEqual({ total: 0, unread: 0 })
  })

  test("groups episodes by project order with collision-safe labels", () => {
    const groups = groupAttentionInbox(
      [
        item("task-b", null, "turn_complete", 4),
        item("task-missing", null, "error", 1),
        item("task-a2", null, "permission_needed", 3),
        item("task-a1", null, "turn_complete", 2),
      ],
      [task("task-a1", "/work/acme/app"), task("task-a2", "/work/acme/app"), task("task-b", "/work/other/app")],
    )

    expect(groups.map((group) => [group.label, group.items.map((entry) => entry.taskId)])).toEqual([
      ["acme/app", ["task-a2", "task-a1"]],
      ["other/app", ["task-b"]],
      [null, ["task-missing"]],
    ])
  })

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
