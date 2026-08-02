import { describe, expect, test } from "vitest"
import {
  type TreeTab,
  buildTreeRows,
  filterTreeRows,
  focusProjectSet,
  parseRowId,
  projectKeysOf,
  tabRowId,
  toggleInSet,
  treeFlatIds,
} from "../../src/tui/panes/sidebar/tree-core"
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

const tab = (id: string, label = id): TreeTab => ({ id, label })

const NOTHING: ReadonlySet<string> = new Set()

function rows(over: Partial<Parameters<typeof buildTreeRows>[0]> = {}) {
  return buildTreeRows({
    tasks: [],
    tabsByTask: new Map(),
    collapsedWorktrees: NOTHING,
    collapsedProjects: NOTHING,
    ...over,
  })
}

describe("buildTreeRows", () => {
  test("groups worktrees under one project header, main first", () => {
    const result = rows({
      tasks: [
        task("b", { branch: "feat/b" }),
        task("m", { kind: "main", repo: "/repos/kobe", branch: "", worktreePath: "/repos/kobe" }),
        task("a", { branch: "feat/a" }),
      ],
    })
    expect(result.map((r) => [r.kind, r.id])).toEqual([
      ["project", "/repos/kobe"],
      // main is a worktree row, not the project row: the project is a repo,
      // the main checkout is a checkout, and only the latter carries tabs.
      ["worktree", "m"],
      ["worktree", "b"],
      ["worktree", "a"],
    ])
  })

  test("keeps projects in stored order rather than sorting them", () => {
    const result = rows({
      tasks: [task("z", { repo: "/repos/zebra" }), task("a", { repo: "/repos/apple" })],
    })
    expect(result.filter((r) => r.kind === "project").map((r) => r.id)).toEqual(["/repos/zebra", "/repos/apple"])
  })

  test("tabs render by default; a hand-collapsed worktree hides its own", () => {
    const tabs = new Map([["a", [tab("tab-1"), tab("tab-2")]]])
    // Default is EXPANDED (owner call 2026-08-01 round 4): no keystroke
    // needed to see any worktree's tabs.
    const expanded = rows({ tasks: [task("a")], tabsByTask: tabs })
    expect(expanded.map((r) => r.id)).toEqual(["/repos/kobe", "a", "a::tab-1", "a::tab-2"])

    const collapsed = rows({ tasks: [task("a")], tabsByTask: tabs, collapsedWorktrees: new Set(["a"]) })
    expect(collapsed.filter((r) => r.kind === "tab")).toHaveLength(0)
  })

  test("a collapsed project hides its worktrees and their tabs", () => {
    const result = rows({
      tasks: [task("a"), task("b", { repo: "/repos/other" })],
      tabsByTask: new Map([["a", [tab("tab-1")]]]),
      collapsedProjects: new Set(["/repos/kobe"]),
    })
    expect(result.map((r) => r.id)).toEqual(["/repos/kobe", "/repos/other", "b"])
  })

  test("a dir task gets no project header — it has no project", () => {
    // `kobe .` on an arbitrary directory. Inventing a header for it would
    // claim a repo relationship that does not exist.
    const result = rows({ tasks: [task("d", { kind: "dir", repo: "/tmp/scratch" })] })
    expect(result.map((r) => [r.kind, r.id])).toEqual([["worktree", "d"]])
  })

  test("a task whose tabs never mounted contributes no tab rows", () => {
    // Absent from the map is "unknown", not "zero tabs" — the difference
    // matters because every task has at least one tab once it mounts.
    const result = rows({ tasks: [task("a")] })
    expect(result.filter((r) => r.kind === "tab")).toHaveLength(0)
  })
})

describe("treeFlatIds", () => {
  test("skips project headers so the cursor can never rest on one", () => {
    const result = rows({
      tasks: [task("a")],
      tabsByTask: new Map([["a", [tab("tab-1")]]]),
    })
    expect(treeFlatIds(result)).toEqual(["a", "a::tab-1"])
  })
})

describe("tabRowId / parseRowId", () => {
  test("round-trips a tab row id", () => {
    expect(parseRowId(tabRowId("task-1", "tab-2"))).toEqual({ taskId: "task-1", tabId: "tab-2" })
  })

  test("a bare task id parses as no tab", () => {
    expect(parseRowId("task-1")).toEqual({ taskId: "task-1", tabId: null })
  })
})

describe("toggleInSet", () => {
  test("adds, removes, and never mutates the input", () => {
    const original: ReadonlySet<string> = new Set(["a"])
    const added = toggleInSet(original, "b")
    expect([...added].sort()).toEqual(["a", "b"])
    expect([...toggleInSet(added, "a")]).toEqual(["b"])
    // Identity must change or React skips the re-render.
    expect(added).not.toBe(original)
    expect([...original]).toEqual(["a"])
  })
})

describe("filterTreeRows", () => {
  // One fixture for the whole block: two projects, a tab under each of the
  // kobe worktrees, so every ancestor/descendant direction has something to
  // prove.
  const tree = () =>
    rows({
      tasks: [
        task("m", { kind: "main", repo: "/repos/kobe", branch: "main", worktreePath: "/repos/kobe" }),
        task("wt", { repo: "/repos/kobe", branch: "feat/tree", title: "worktree tree" }),
        task("fx", { repo: "/repos/foxychat", branch: "feat/chat", title: "chat rewrite" }),
      ],
      tabsByTask: new Map([
        ["m", [tab("tab-1", "shell")]],
        ["wt", [tab("tab-2", "running codex on the landing page")]],
        ["fx", [tab("tab-3", "vitest watch")]],
      ]),
    })

  const ids = (query: string) => filterTreeRows(tree(), query).map((r) => r.id)

  test("an empty query is a no-op", () => {
    expect(filterTreeRows(tree(), "   ")).toEqual(tree())
  })

  test("a tab hit keeps its worktree and project", () => {
    // The tree's whole increment over the flat sidebar: the query matches
    // nothing but a live tab TITLE, and the ancestors come along so the hit
    // is placed rather than floating.
    expect(ids("codex")).toEqual(["/repos/kobe", "wt", "wt::tab-2"])
  })

  test("a worktree hit keeps its tabs", () => {
    expect(ids("feat/tree")).toEqual(["/repos/kobe", "wt", "wt::tab-2"])
  })

  test("a project hit keeps the whole subtree", () => {
    expect(ids("foxychat")).toEqual(["/repos/foxychat", "fx", "fx::tab-3"])
  })

  test("no matches yields no rows — not a bare project header", () => {
    expect(ids("zzzz")).toEqual([])
  })

  test("a dir task has no project header to keep alive", () => {
    const loose = rows({
      tasks: [task("d", { kind: "dir", repo: "/tmp/scratch", branch: "", title: "scratchpad" })],
      tabsByTask: new Map(),
    })
    expect(filterTreeRows(loose, "scratch").map((r) => r.id)).toEqual(["d"])
  })
})

describe("projectKeysOf", () => {
  test("first-seen order, deduped, dir tasks excluded", () => {
    expect(
      projectKeysOf([
        task("a", { repo: "/repos/kobe" }),
        task("b", { repo: "/repos/foxychat" }),
        task("c", { repo: "/repos/kobe" }),
        task("d", { kind: "dir", repo: "/tmp/scratch" }),
      ]),
    ).toEqual(["/repos/kobe", "/repos/foxychat"])
  })
})

describe("focusProjectSet", () => {
  const all = ["p1", "p2", "p3"]

  test("folds every project but the kept one", () => {
    expect([...focusProjectSet(all, "p2", NOTHING)]).toEqual(["p1", "p3"])
  })

  test("a second press on the already-focused project unfolds everything", () => {
    const focused = focusProjectSet(all, "p2", NOTHING)
    expect([...focusProjectSet(all, "p2", focused)]).toEqual([])
  })

  test("focusing a DIFFERENT project re-folds rather than unfolding", () => {
    const focused = focusProjectSet(all, "p2", NOTHING)
    expect([...focusProjectSet(all, "p3", focused)]).toEqual(["p1", "p2"])
  })

  test("a lone project has nothing to fold, so it never latches as focused", () => {
    expect([...focusProjectSet(["p1"], "p1", NOTHING)]).toEqual([])
  })
})
