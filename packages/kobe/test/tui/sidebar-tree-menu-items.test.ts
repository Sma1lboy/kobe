/**
 * What each tree row's right-click menu OFFERS (`tree-menu.ts` — pure, so the
 * list is a data assertion; the real right-click that produces it is covered
 * in the render track's `sidebar-tree-menu.test.tsx`).
 *
 * The rules worth locking: a project header is only ever "New task", the
 * per-task verbs reach a tab row too, `closeTab` appears only above one tab,
 * and the new-conversation pair rides both task-bearing row kinds.
 */

import { describe, expect, test } from "vitest"
import type { TreeRow } from "../../src/tui/panes/sidebar/tree-core"
import { treeMenuItems } from "../../src/tui/panes/sidebar/tree-menu"
import { type Task, toTaskId } from "../../src/types/task"

function task(over: Partial<Task> = {}): Task {
  return {
    id: toTaskId("a"),
    title: "a",
    repo: "/repos/rove",
    branch: "feat/a",
    worktreePath: "/wt/a",
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}

const projectRow: TreeRow = { kind: "project", id: "/repos/rove", repo: "/repos/rove", label: "kobe", depth: 0 }
const worktreeRow = (over: Partial<Task> = {}): TreeRow => ({ kind: "worktree", id: "a", task: task(over), depth: 1 })
const tabRow: TreeRow = { kind: "tab", id: "a::tab-2", task: task(), tab: { id: "tab-2", label: "tab 2" }, depth: 2 }

const actions = (row: TreeRow, ctx = {}) => treeMenuItems(row, ctx).map((item) => item.action)

describe("treeMenuItems", () => {
  test("a project header only offers New task", () => {
    expect(actions(projectRow)).toEqual(["newTask"])
  })

  test("a worktree row opens, adds a session, then the task verbs", () => {
    expect(actions(worktreeRow())).toEqual([
      "open",
      "newChat",
      "newShell",
      "rename",
      "pin",
      "localMerge",
      "archive",
      "delete",
    ])
  })

  test("a tab row carries the same session + task verbs, plus its own close", () => {
    expect(actions(tabRow, { tabCount: 2 })).toEqual([
      "open",
      "closeTab",
      "newChat",
      "newShell",
      "rename",
      "pin",
      "localMerge",
      "archive",
      "delete",
    ])
  })

  test("the LAST tab is not offered a close (closeTab would refuse it)", () => {
    expect(actions(tabRow, { tabCount: 1 })).not.toContain("closeTab")
    // …but it can still start a new session, which is what makes the refusal
    // reachable in the first place.
    expect(actions(tabRow, { tabCount: 1 })).toContain("newChat")
  })

  test("pin reads the task's own state", () => {
    const label = (row: TreeRow) => treeMenuItems(row).find((item) => item.action === "pin")?.labelKey
    expect(label(worktreeRow())).toBe("tasks.menu.pin")
    expect(label(worktreeRow({ pinned: true }))).toBe("tasks.menu.unpin")
  })

  test("delete is the only entry painted as destructive", () => {
    const danger = treeMenuItems(worktreeRow())
      .filter((item) => item.danger === true)
      .map((item) => item.action)
    expect(danger).toEqual(["delete"])
  })
})
