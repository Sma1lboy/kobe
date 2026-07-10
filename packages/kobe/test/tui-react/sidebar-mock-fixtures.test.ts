/**
 * Invariants for the shared sidebar mock fixtures (issue #15, G3): the
 * smoke hosts (Solid + React) and the render-proof grep both key off this
 * data, so pin the shape — a project row that stops satisfying the `main`
 * contract or a renamed fixture title would silently hollow out the
 * dev:mock-react-sidebar gate.
 */

import { describe, expect, it } from "vitest"
import { buildRows, splitSidebarRows } from "../../src/tui/panes/sidebar/groups"
import { MOCK_SIDEBAR_REPO, seedSidebarTasks } from "../../src/tui/panes/sidebar/mock-fixtures"

describe("seedSidebarTasks", () => {
  it("provides unique ids and main project rows satisfying the main contract", () => {
    const tasks = seedSidebarTasks()
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length)
    const mains = tasks.filter((t) => t.kind === "main")
    // Several sibling projects so the PROJECTS scrollbox actually overflows
    // in the mock host (scrollbar/budget tuning bench).
    expect(mains.length).toBeGreaterThanOrEqual(5)
    for (const main of mains) {
      // main rows pin the repo root: worktreePath === repo, branch === ""
      expect(main.worktreePath).toBe(main.repo)
      expect(main.branch).toBe("")
    }
    expect(mains.some((m) => m.repo === MOCK_SIDEBAR_REPO)).toBe(true)
  })

  it("covers both views and feeds buildRows a project + task split", () => {
    const tasks = seedSidebarTasks()
    expect(tasks.some((t) => t.archived)).toBe(true)
    const { projectRows, taskRows } = splitSidebarRows(buildRows(tasks, "active"))
    expect(projectRows.length).toBe(tasks.filter((t) => t.kind === "main").length)
    expect(taskRows.length).toBeGreaterThanOrEqual(2)
    // Pinned task floats to the top of the TASKS section.
    expect(taskRows[0]?.task.pinned).toBe(true)
    // The render-proof grep string stays stable.
    expect(taskRows.map((r) => r.task.title)).toContain("Port sidebar to React")
  })
})
