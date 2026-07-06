import { describe, expect, it } from "vitest"
import { buildRows, splitSidebarRows } from "../../src/tui/panes/sidebar/groups"
import { MOCK_SIDEBAR_REPO, seedSidebarTasks } from "../../src/tui/panes/sidebar/mock-fixtures"

describe("seedSidebarTasks", () => {
  it("provides unique ids and one main project row satisfying the main contract", () => {
    const tasks = seedSidebarTasks()
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length)
    const mains = tasks.filter((t) => t.kind === "main")
    expect(mains).toHaveLength(1)
    expect(mains[0]?.repo).toBe(MOCK_SIDEBAR_REPO)
    expect(mains[0]?.worktreePath).toBe(MOCK_SIDEBAR_REPO)
    expect(mains[0]?.branch).toBe("")
  })

  it("covers both views and feeds buildRows a project + task split", () => {
    const tasks = seedSidebarTasks()
    expect(tasks.some((t) => t.archived)).toBe(true)
    const { projectRows, taskRows } = splitSidebarRows(buildRows(tasks, "active"))
    expect(projectRows.length).toBe(1)
    expect(taskRows.length).toBeGreaterThanOrEqual(2)
    expect(taskRows[0]?.task.pinned).toBe(true)
    expect(taskRows.map((r) => r.task.title)).toContain("Port sidebar to React")
  })
})
