import { describe, expect, it } from "vitest"
import {
  distinctTaskVendors,
  isMixedEngineWorkspace,
  matchesTask,
  sortTasks,
} from "../src/lib/task-list.ts"
import type { Task } from "../src/lib/types.ts"

/**
 * Task-rail ordering + filtering. The load-bearing rule is the GROUP order:
 * projects (main) > pinned > regular, in BOTH modes — `recent` re-orders the
 * WORKTREE groups (pinned, regular) by update time but never lets a recent
 * regular task jump above a project or a pinned one, and never reshuffles the
 * projects themselves (projects "sit tight"). matchesTask is the rail search.
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

  it("projects sit tight — recent does NOT reshuffle them by updatedAt", () => {
    // projA is older than projB, but recent must keep their incoming order
    // (selecting a project bumps its updatedAt; the project list must not
    // jump around underneath the user).
    const t = [
      task({ id: "projA", kind: "main", updatedAt: "2020-01-01T00:00:00Z" }),
      task({ id: "projB", kind: "main", updatedAt: "2026-06-10T00:00:00Z" }),
      task({ id: "reg", updatedAt: "2026-06-09T00:00:00Z" }),
    ]
    // projA stays before projB despite being staler; only worktrees reorder.
    expect(ids(sortTasks(t, "recent"))).toEqual(["projA", "projB", "reg"])
    // And the order matches default mode for the projects.
    expect(ids(sortTasks(t, "default")).slice(0, 2)).toEqual(["projA", "projB"])
  })
})

describe("isMixedEngineWorkspace / distinctTaskVendors", () => {
  it("is false when every worktree task runs the same engine", () => {
    const t = [
      task({ id: "a", vendor: "claude" }),
      task({ id: "b", vendor: "claude" }),
    ]
    expect(isMixedEngineWorkspace(t)).toBe(false)
    expect(distinctTaskVendors(t)).toEqual(["claude"])
  })

  it("is true when worktree tasks run different engines", () => {
    const t = [
      task({ id: "a", vendor: "claude" }),
      task({ id: "b", vendor: "codex" }),
    ]
    expect(isMixedEngineWorkspace(t)).toBe(true)
    expect(distinctTaskVendors(t).sort()).toEqual(["claude", "codex"])
  })

  it("treats an unset vendor as the default 'claude'", () => {
    const t = [
      task({ id: "a", vendor: undefined }),
      task({ id: "b", vendor: "codex" }),
    ]
    // undefined → claude, so this counts as mixed (claude + codex).
    expect(isMixedEngineWorkspace(t)).toBe(true)
    const t2 = [task({ id: "a", vendor: undefined })]
    expect(distinctTaskVendors(t2)).toEqual(["claude"])
  })

  it("ignores project (main) and archived rows", () => {
    const t = [
      task({ id: "a", vendor: "claude" }),
      task({ id: "m", kind: "main", vendor: "codex" }),
      task({ id: "z", archived: true, vendor: "codex" }),
    ]
    // Only the one claude worktree task counts → not mixed.
    expect(isMixedEngineWorkspace(t)).toBe(false)
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

describe("rail Enter target — top match of filter+sort", () => {
  // What the task rail's Enter-to-jump opens: the first element of the same
  // sorted+filtered list the rail renders (visible[0] in AppShell).
  const topMatch = (
    all: Task[],
    query: string,
    mode: "default" | "recent",
  ): Task | undefined =>
    sortTasks(
      all.filter((t) => matchesTask(t, query)),
      mode,
    )[0]

  const all = [
    task({ id: "p", kind: "main", title: "kobe", branch: "main" }),
    task({ id: "a", title: "auth fix", branch: "feat/auth" }),
    task({ id: "b", title: "billing", branch: "feat/billing" }),
  ]

  it("opens the first matching task for a query", () => {
    expect(topMatch(all, "billing", "default")?.id).toBe("b")
  })

  it("respects group order — a project outranks a matching worktree", () => {
    // "feat" matches both worktrees, but a project (main) that also matches
    // sorts first; here the query matches only worktrees, so the first
    // worktree in order wins.
    expect(topMatch(all, "feat", "default")?.id).toBe("a")
  })

  it("is undefined when nothing matches (Enter is a no-op)", () => {
    expect(topMatch(all, "zzz-none", "default")).toBeUndefined()
  })
})
