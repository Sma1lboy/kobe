import { describe, expect, test } from "vitest"
import {
  type TreeTab,
  buildTreeRows,
  filterTreeRows,
  mainTaskIdOfProject,
  parseRowId,
  projectKeysOf,
  tabRowId,
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

function rows(over: Partial<Parameters<typeof buildTreeRows>[0]> = {}) {
  return buildTreeRows({
    tasks: [],
    tabsByTask: new Map(),
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

  test("every tab always renders — the tree has no fold", () => {
    // Owner call 2026-08-01 round 5: no collapse anywhere, ever. The tree is
    // a map; hiding rows made the map lie.
    const tabs = new Map([["a", [tab("tab-1"), tab("tab-2")]]])
    const result = rows({ tasks: [task("a")], tabsByTask: tabs })
    expect(result.map((r) => r.id)).toEqual(["/repos/kobe", "a", "a::tab-1", "a::tab-2"])
  })

  test("a dir task groups under its directory as the project header", () => {
    // `kobe .` on an arbitrary directory (owner 2026-08-02): loose rows
    // after the last project read as THAT project's rows, so the directory
    // itself is the header — same grouping rule as every other task.
    const result = rows({ tasks: [task("d", { kind: "dir", repo: "/tmp/scratch" })] })
    expect(result.map((r) => [r.kind, r.id])).toEqual([
      ["project", "/tmp/scratch"],
      ["worktree", "d"],
    ])
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

  test("a dir task's hit keeps its directory header", () => {
    const loose = rows({
      tasks: [task("d", { kind: "dir", repo: "/tmp/scratch", branch: "", title: "scratchpad" })],
      tabsByTask: new Map(),
    })
    expect(filterTreeRows(loose, "scratch").map((r) => r.id)).toEqual(["/tmp/scratch", "d"])
  })
})

describe("projectKeysOf", () => {
  test("first-seen order, deduped; a dir task contributes its directory", () => {
    expect(
      projectKeysOf([
        task("a", { repo: "/repos/kobe" }),
        task("b", { repo: "/repos/foxychat" }),
        task("c", { repo: "/repos/kobe" }),
        task("d", { kind: "dir", repo: "/tmp/scratch" }),
      ]),
    ).toEqual(["/repos/kobe", "/repos/foxychat", "/tmp/scratch"])
  })
})

describe("mainTaskIdOfProject", () => {
  const tasks = [
    task("kobe-wt", { repo: "/repos/kobe" }),
    task("kobe-main", { kind: "main", repo: "/repos/kobe", branch: "main", worktreePath: "/repos/kobe" }),
    task("fox-main", { kind: "main", repo: "/repos/foxychat", branch: "main", worktreePath: "/repos/foxychat" }),
  ]

  test("finds the repo's main checkout, not its first task", () => {
    // Project reorder rides on the MAIN row (mains move among mains), so
    // picking the first task of the repo would move nothing.
    expect(mainTaskIdOfProject(tasks, "/repos/kobe")).toBe("kobe-main")
    expect(mainTaskIdOfProject(tasks, "/repos/foxychat")).toBe("fox-main")
  })

  test("a project with no main checkout has nothing to move", () => {
    expect(mainTaskIdOfProject([task("only", { repo: "/repos/orphan" })], "/repos/orphan")).toBeNull()
  })

  test("an unknown project is null, not a throw", () => {
    expect(mainTaskIdOfProject(tasks, "/repos/nope")).toBeNull()
  })
})
