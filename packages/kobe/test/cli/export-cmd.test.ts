import { describe, expect, it } from "vitest"
import { renderExport } from "../../src/cli/export-cmd.ts"
import { type Task, toTaskId } from "../../src/types/task.ts"

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: toTaskId("01HZ0000000000000000000001"),
    title: "Fix the thing",
    repo: "/home/u/repo",
    branch: "kobe/fix-thing-01",
    worktreePath: "/home/u/.kobe/worktrees/repo/fix-thing-01",
    status: "in_progress",
    archived: false,
    vendor: "claude",
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
    ...overrides,
  }
}

describe("renderExport", () => {
  it("emits a JSON array that round-trips and carries the documented fields", () => {
    const parsed = JSON.parse(renderExport([task()], "json"))
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0]).toMatchObject({
      id: "01HZ0000000000000000000001",
      title: "Fix the thing",
      status: "in_progress",
      archived: "false",
      vendor: "claude",
      branch: "kobe/fix-thing-01",
      repo: "/home/u/repo",
      worktreePath: "/home/u/.kobe/worktrees/repo/fix-thing-01",
    })
  })

  it("defaults a missing vendor to the task default", () => {
    const parsed = JSON.parse(renderExport([task({ vendor: undefined })], "json"))
    expect(parsed[0].vendor).toBe("claude")
  })

  it("writes a CSV header plus one row per task", () => {
    const csv = renderExport([task(), task({ id: toTaskId("01HZ0000000000000000000002") })], "csv")
    const lines = csv.split("\n")
    expect(lines[0]).toBe("id,title,status,archived,vendor,branch,repo,worktreePath")
    expect(lines).toHaveLength(3)
  })

  it("quotes and escapes CSV fields containing commas or quotes", () => {
    const csv = renderExport([task({ title: 'a, "b"' })], "csv")
    expect(csv.split("\n")[1]).toContain('"a, ""b"""')
  })

  it("renders an aligned table with a header row", () => {
    const table = renderExport([task()], "table")
    const lines = table.split("\n")
    expect(lines[0].startsWith("id")).toBe(true)
    expect(lines[1]).toContain("Fix the thing")
  })

  it("handles an empty task list per format", () => {
    expect(renderExport([], "json")).toBe("[]")
    expect(renderExport([], "csv")).toBe("id,title,status,archived,vendor,branch,repo,worktreePath")
  })
})
