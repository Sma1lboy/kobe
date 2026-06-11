import { describe, expect, it } from "vitest"
import { matchesTask, sortTasks } from "../src/lib/task-list.ts"
import type { Task } from "../src/lib/types.ts"

/**
 * Task-rail ordering + filtering. The load-bearing rule is the GROUP order:
 * projects (main) > pinned > regular, in BOTH modes — `recent` only re-orders
 * within each group by update time, it never lets a recent regular task jump
 * above a project or a pinned one. matchesTask is the rail search.
 */

const task = (over: Partial<Task>): Task =>
  ({
    id: over.id ?? "t",
    kind: "task",
    pinned: false,
    title: "",
    ...over,
  }) as Task

const ids = (tasks: Task[]) => tasks.map((t) => t.id)

describe("sortTasks — grouping", () => {
  const tasks = [
    task({ id: "reg1" }),
    task({ id: "proj", kind: "main" }),
    task({ id: "pin1", pinned: true }),
    task({ id: "reg2" }),
  ]

  it("orders projects, then pinned, then regular (default mode)", () => {
    expect(ids(sortTasks(tasks, "default"))).toEqual([
      "proj",
      "pin1",
      "reg1",
      "reg2",
    ])
  })

  it("preserves incoming order within a group in default mode", () => {
    const t = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })]
    expect(ids(sortTasks(t, "default"))).toEqual(["a", "b", "c"])
  })

  it("does not mutate the input array", () => {
    const input = [...tasks]
    sortTasks(input, "recent")
    expect(ids(input)).toEqual(["reg1", "proj", "pin1", "reg2"])
  })
})

describe("sortTasks — recent mode", () => {
  it("orders within each group by updatedAt, newest first", () => {
    const t = [
      task({ id: "old", updatedAt: "2026-06-01T00:00:00Z" }),
      task({ id: "new", updatedAt: "2026-06-10T00:00:00Z" }),
      task({ id: "mid", updatedAt: "2026-06-05T00:00:00Z" }),
    ]
    expect(ids(sortTasks(t, "recent"))).toEqual(["new", "mid", "old"])
  })

  it("keeps a recent regular task BELOW a stale project + pinned", () => {
    const t = [
      task({ id: "regNew", updatedAt: "2026-06-10T00:00:00Z" }),
      task({ id: "projOld", kind: "main", updatedAt: "2020-01-01T00:00:00Z" }),
      task({ id: "pinOld", pinned: true, updatedAt: "2020-01-01T00:00:00Z" }),
    ]
    expect(ids(sortTasks(t, "recent"))).toEqual([
      "projOld",
      "pinOld",
      "regNew",
    ])
  })

  it("falls back to createdAt, then id, for a stable order", () => {
    const t = [
      task({ id: "b", createdAt: "2026-06-01T00:00:00Z" }),
      task({ id: "a", createdAt: "2026-06-01T00:00:00Z" }),
    ]
    // Equal times → id tiebreak (localeCompare(b.id, a.id), so "b" before "a").
    expect(ids(sortTasks(t, "recent"))).toEqual(["b", "a"])
  })
})

describe("matchesTask", () => {
  const t = task({
    id: "x",
    title: "Fix login",
    branch: "feat/auth",
    repo: "kobe",
    vendor: "claude",
  })

  it("matches everything for an empty query", () => {
    expect(matchesTask(t, "")).toBe(true)
  })

  it("matches case-insensitively across title/branch/repo/vendor", () => {
    expect(matchesTask(t, "LOGIN")).toBe(true)
    expect(matchesTask(t, "auth")).toBe(true)
    expect(matchesTask(t, "kobe")).toBe(true)
    expect(matchesTask(t, "Claude")).toBe(true)
  })

  it("returns false when nothing contains the query", () => {
    expect(matchesTask(t, "zzz-nope")).toBe(false)
  })

  it("ignores absent fields without throwing", () => {
    expect(matchesTask(task({ id: "y" }), "anything")).toBe(false)
    expect(matchesTask(task({ id: "y" }), "")).toBe(true)
  })
})
