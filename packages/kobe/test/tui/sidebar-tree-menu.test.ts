/**
 * What the tree's right-click menu offers per row kind.
 *
 * The invariant under test is the module's own rule — a row's menu is what
 * that row's KEYBOARD already does — so these cases are what stops the menu
 * from quietly growing capabilities the chords don't have.
 */

import { describe, expect, test } from "vitest"
import type { TreeRow } from "../../src/tui/panes/sidebar/tree-core"
import { treeMenuItems } from "../../src/tui/panes/sidebar/tree-menu"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/kobe",
    branch: `feat/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}

const projectRow: TreeRow = { kind: "project", id: "/repos/kobe", repo: "/repos/kobe", label: "kobe", depth: 0 }
const worktreeRow = (over: Partial<Task> = {}): TreeRow => ({
  kind: "worktree",
  id: "a",
  task: task("a", over),
  depth: 1,
})
const tabRow: TreeRow = {
  kind: "tab",
  id: "a::tab-1",
  task: task("a"),
  tab: { id: "tab-1", label: "shell" },
  depth: 2,
}

const actions = (row: TreeRow, ctx = {}) => treeMenuItems(row, ctx).map((item) => item.action)
const labels = (row: TreeRow, ctx = {}) => treeMenuItems(row, ctx).map((item) => item.labelKey)

describe("treeMenuItems", () => {
  test("a project offers the three things its header can do", () => {
    expect(actions(projectRow)).toEqual(["toggle", "focusProject", "newTask"])
  })

  test("project labels follow collapse and focus state", () => {
    expect(labels(projectRow, { collapsed: false })[0]).toBe("tasks.menu.collapse")
    expect(labels(projectRow, { collapsed: true })[0]).toBe("tasks.menu.expand")
    expect(labels(projectRow, { projectFocused: false })[1]).toBe("tasks.menu.focusProject")
    expect(labels(projectRow, { projectFocused: true })[1]).toBe("tasks.menu.showAllProjects")
  })

  test("a worktree with no tabs omits the toggle entirely", () => {
    // An "Expand" that visibly does nothing is worse than no entry.
    expect(actions(worktreeRow(), { hasTabs: false })).not.toContain("toggle")
    expect(actions(worktreeRow(), { hasTabs: true })).toContain("toggle")
  })

  test("a worktree carries open plus every per-task verb", () => {
    expect(actions(worktreeRow(), { hasTabs: false })).toEqual([
      "open",
      "rename",
      "pin",
      "localMerge",
      "archive",
      "delete",
    ])
  })

  test("pin flips to unpin on a pinned task", () => {
    expect(labels(worktreeRow({ pinned: true }))).toContain("tasks.menu.unpin")
    expect(labels(worktreeRow({ pinned: false }))).toContain("tasks.menu.pin")
  })

  test("a tab row opens the TAB but keeps the parent's task verbs", () => {
    // Matches the chords: `withCursorTask` already walks up from a tab row,
    // because rename/archive/delete have no tab-level meaning.
    expect(actions(tabRow)).toEqual(["open", "rename", "pin", "localMerge", "archive", "delete"])
    expect(labels(tabRow)[0]).toBe("tasks.menu.openTab")
  })

  test("delete is the only entry marked destructive", () => {
    const dangerous = treeMenuItems(worktreeRow()).filter((item) => item.danger === true)
    expect(dangerous.map((item) => item.action)).toEqual(["delete"])
  })
})
