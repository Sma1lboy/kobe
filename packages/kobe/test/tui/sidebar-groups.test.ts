import { describe, expect, it } from "vitest"
import { buildRows } from "../../src/tui/panes/sidebar/groups.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

function task(overrides: Omit<Partial<Task>, "id"> & { id: string; title: string }): Task {
  return {
    repo: "/repo/kobe",
    branch: overrides.title,
    worktreePath: `/repo/kobe/${overrides.id}`,
    kind: "task",
    status: "backlog",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    id: toTaskId(overrides.id),
  } as Task
}

function ids(rows: ReturnType<typeof buildRows>): string[] {
  return rows.map((row) => String(row.task.id))
}

describe("sidebar task ordering", () => {
  it("keeps default order as projects, pinned tasks, then persisted task order", () => {
    const rows = buildRows(
      [
        task({ id: "regular-a", title: "a" }),
        task({ id: "project", title: "repo", kind: "main", repo: "/repo/zeta" }),
        task({ id: "regular-b", title: "b" }),
        task({ id: "pinned", title: "pinned", pinned: true }),
      ],
      "active",
      "",
      "default",
    )

    expect(ids(rows)).toEqual(["project", "pinned", "regular-a", "regular-b"])
  })

  it("orders each section by recent use in recent mode", () => {
    const rows = buildRows(
      [
        task({ id: "old", title: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
        task({ id: "new", title: "new", updatedAt: "2026-01-03T00:00:00.000Z" }),
        task({ id: "pinned-old", title: "pinned old", pinned: true, updatedAt: "2026-01-02T00:00:00.000Z" }),
        task({ id: "pinned-new", title: "pinned new", pinned: true, updatedAt: "2026-01-04T00:00:00.000Z" }),
      ],
      "active",
      "",
      "recent",
    )

    expect(ids(rows)).toEqual(["pinned-new", "pinned-old", "new", "old"])
  })
})
