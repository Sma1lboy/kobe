import { describe, expect, test } from "vitest"
import {
  RECENT_ROW_ID,
  SCRATCH_SECTION_ID,
  type TreeTab,
  buildTreeRows,
  filterTreeRows,
  mainTaskIdOfProject,
  parseRowId,
  projectKeysOf,
  tabRowId,
  treeFlatIds,
  withRecentRow,
  worktreeRowLabel,
} from "../../src/tui/panes/sidebar/tree-core"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/rove",
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
        task("m", { kind: "main", repo: "/repos/rove", branch: "", worktreePath: "/repos/rove" }),
        task("a", { branch: "feat/a" }),
      ],
    })
    expect(result.map((r) => [r.kind, r.id])).toEqual([
      ["project", "/repos/rove"],
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

  test("project order follows the MAINS' stored order, not first-seen task order", () => {
    // The move-mode contract: `moveTask` on a main swaps it among mains, so
    // the tree must key project order on main order — an older regular task
    // must not anchor its project ahead of the swap (that made project
    // move-mode read as a no-op).
    const result = rows({
      tasks: [
        task("old-z-task", { repo: "/repos/zebra" }),
        task("m-apple", { kind: "main", repo: "/repos/apple", worktreePath: "/repos/apple" }),
        task("m-zebra", { kind: "main", repo: "/repos/zebra", worktreePath: "/repos/zebra" }),
      ],
    })
    expect(result.filter((r) => r.kind === "project").map((r) => r.id)).toEqual(["/repos/apple", "/repos/zebra"])
  })

  test("a main-less project appends after the main-ordered ones", () => {
    const result = rows({
      tasks: [
        task("loose", { repo: "/repos/no-main" }),
        task("m", { kind: "main", repo: "/repos/rove", worktreePath: "/repos/rove" }),
      ],
    })
    expect(result.filter((r) => r.kind === "project").map((r) => r.id)).toEqual(["/repos/rove", "/repos/no-main"])
  })

  test("every tab always renders — the tree has no fold", () => {
    // Owner call 2026-08-01 round 5: no collapse anywhere, ever. The tree is
    // a map; hiding rows made the map lie.
    const tabs = new Map([["a", [tab("tab-1"), tab("tab-2")]]])
    const result = rows({ tasks: [task("a")], tabsByTask: tabs })
    expect(result.map((r) => r.id)).toEqual(["/repos/rove", "a", "a::tab-1", "a::tab-2"])
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

  test("scratch tasks render in one Scratch section above every project (issue #33)", () => {
    const result = rows({
      tasks: [
        task("m", { kind: "main", repo: "/repos/rove", branch: "", worktreePath: "/repos/rove" }),
        task("s1", { kind: "dir", scratch: true, repo: "/Users/me" }),
        task("s2", { kind: "dir", scratch: true, repo: "/Users/me" }),
      ],
    })
    expect(result.map((r) => [r.kind, r.id])).toEqual([
      ["project", SCRATCH_SECTION_ID],
      ["worktree", "s1"],
      ["worktree", "s2"],
      ["project", "/repos/rove"],
      ["worktree", "m"],
    ])
  })

  test("a scratch task with tabs renders NO worktree row — tabs hang under the header (issue #41)", () => {
    // The auto-generated scratch name is noise; the shell IS the session.
    // The task stays real in the data layer — only its middle row is skipped.
    const result = rows({
      tasks: [
        task("s", { kind: "dir", scratch: true, repo: "/Users/me" }),
        task("m", { kind: "main", repo: "/repos/rove", branch: "", worktreePath: "/repos/rove" }),
      ],
      tabsByTask: new Map([["s", [tab("tab-1"), tab("tab-2")]]]),
    })
    expect(result.map((r) => [r.kind, r.id])).toEqual([
      ["project", SCRATCH_SECTION_ID],
      ["tab", "s::tab-1"],
      ["tab", "s::tab-2"],
      ["project", "/repos/rove"],
      ["worktree", "m"],
    ])
    // Every emitted row is navigable — no unreachable middle level.
    expect(treeFlatIds(result)).toEqual(["s::tab-1", "s::tab-2", "m"])
  })

  test("a scratch task whose tabs never mounted keeps its worktree row as the only handle", () => {
    // Zero rows would make the task invisible AND unnavigable; the fallback
    // row is what the cursor (and delete/archive) can still land on.
    const result = rows({ tasks: [task("s", { kind: "dir", scratch: true, repo: "/Users/me" })] })
    expect(result.map((r) => [r.kind, r.id])).toEqual([
      ["project", SCRATCH_SECTION_ID],
      ["worktree", "s"],
    ])
  })

  test("a scratch task never mints a project header for its directory", () => {
    // Same dir, one scratch + one ordinary dir task: only the ordinary one
    // groups under the directory; the scratch row lives in Scratch.
    const result = rows({
      tasks: [task("s", { kind: "dir", scratch: true, repo: "/tmp/x" }), task("d", { kind: "dir", repo: "/tmp/x" })],
    })
    expect(result.map((r) => [r.kind, r.id])).toEqual([
      ["project", SCRATCH_SECTION_ID],
      ["worktree", "s"],
      ["project", "/tmp/x"],
      ["worktree", "d"],
    ])
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
        task("m", { kind: "main", repo: "/repos/rove", branch: "main", worktreePath: "/repos/rove" }),
        task("wt", { repo: "/repos/rove", branch: "feat/tree", title: "worktree tree" }),
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
    expect(ids("codex")).toEqual(["/repos/rove", "wt", "wt::tab-2"])
  })

  test("a worktree hit keeps its tabs", () => {
    expect(ids("feat/tree")).toEqual(["/repos/rove", "wt", "wt::tab-2"])
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
        task("a", { repo: "/repos/rove" }),
        task("b", { repo: "/repos/foxychat" }),
        task("c", { repo: "/repos/rove" }),
        task("d", { kind: "dir", repo: "/tmp/scratch" }),
      ]),
    ).toEqual(["/repos/rove", "/repos/foxychat", "/tmp/scratch"])
  })
})

describe("mainTaskIdOfProject", () => {
  const tasks = [
    task("kobe-wt", { repo: "/repos/rove" }),
    task("kobe-main", { kind: "main", repo: "/repos/rove", branch: "main", worktreePath: "/repos/rove" }),
    task("fox-main", { kind: "main", repo: "/repos/foxychat", branch: "main", worktreePath: "/repos/foxychat" }),
  ]

  test("finds the repo's main checkout, not its first task", () => {
    // Project reorder rides on the MAIN row (mains move among mains), so
    // picking the first task of the repo would move nothing.
    expect(mainTaskIdOfProject(tasks, "/repos/rove")).toBe("kobe-main")
    expect(mainTaskIdOfProject(tasks, "/repos/foxychat")).toBe("fox-main")
  })

  test("a project with no main checkout has nothing to move", () => {
    expect(mainTaskIdOfProject([task("only", { repo: "/repos/orphan" })], "/repos/orphan")).toBeNull()
  })

  test("an unknown project is null, not a throw", () => {
    expect(mainTaskIdOfProject(tasks, "/repos/nope")).toBeNull()
  })
})

// `tabRowActivity` moved to the golden matrix
// (`test/golden/sidebar-row-state.golden.txt`, "which entry a TAB row may
// read"), which enumerates its whole truth table — tabActivity present/absent
// x reportedTabCount 0/1/2 x active — instead of the five rows sampled here.

describe("withRecentRow", () => {
  test("prepends a navigable recent row whose id no task can own", () => {
    const recent = task("b")
    const all = withRecentRow(rows({ tasks: [task("a"), recent], tabsByTask: new Map() }), recent)
    expect(all[0]).toMatchObject({ kind: "recent", id: RECENT_ROW_ID, task: recent })
    // The cursor can land on it: flatIds include it, first.
    expect(treeFlatIds(all)[0]).toBe(RECENT_ROW_ID)
    // parseRowId on the synthetic id yields a task id no ULID can be —
    // cursor chords that miss the special case fall through to a lookup miss.
    expect(parseRowId(RECENT_ROW_ID)).toEqual({ taskId: RECENT_ROW_ID, tabId: null })
  })

  test("no recent task = rows unchanged", () => {
    const base = rows({ tasks: [task("a")], tabsByTask: new Map() })
    expect(withRecentRow(base, null)).toEqual(base)
  })
})

describe("worktreeRowLabel (issue #42)", () => {
  test("a branch names the row, over everything else", () => {
    expect(worktreeRowLabel(task("a", { branch: "feat/a", title: "some title" }))).toBe("feat/a")
  })

  test("a main row's live HEAD outranks its (empty) stored branch", () => {
    const main = task("m", { kind: "main", branch: "", worktreePath: "/repos/rove" })
    expect(worktreeRowLabel(main, { liveBranch: "main" })).toBe("main")
    // HEAD not resolved yet (poller cold) → title fallback, same as before.
    expect(worktreeRowLabel(main, { home: "/Users/me" })).toBe("m")
  })

  test("a branchless dir task is named by its tail-truncated path — its stored title is ignored", () => {
    const dir = task("d", {
      kind: "dir",
      branch: "",
      title: "jacksonc-ab3x",
      worktreePath: "/Users/me/projects/deep/nested/dir",
      repo: "/Users/me/projects/deep/nested/dir",
    })
    const label = worktreeRowLabel(dir, { home: "/Users/me" })
    // "~/projects/deep/nested/dir" is 26 chars → tail-truncated to 24.
    expect(label).toBe("…rojects/deep/nested/dir")
    expect(label).not.toContain("jacksonc")
  })

  test("a path under $HOME tildifies before truncation", () => {
    const dir = task("d", { kind: "dir", branch: "", title: "", worktreePath: "/Users/me/tmp", repo: "/Users/me/tmp" })
    expect(worktreeRowLabel(dir, { home: "/Users/me" })).toBe("~/tmp")
  })

  test("a scratch task with an empty title never renders blank", () => {
    const scratch = task("s", {
      kind: "dir",
      scratch: true,
      branch: "",
      title: "",
      worktreePath: "/Users/me",
      repo: "/Users/me",
    })
    expect(worktreeRowLabel(scratch, { home: "/Users/me" })).toBe("~")
  })

  test("a regular task before its worktree materialises keeps its title", () => {
    expect(worktreeRowLabel(task("t", { branch: "", title: "fix the bug", worktreePath: "" }))).toBe("fix the bug")
  })

  test("nothing at all still yields a label", () => {
    const bare = task("x", { kind: "dir", branch: "", title: "", worktreePath: "", repo: "" })
    expect(worktreeRowLabel(bare)).toBe("scratch")
  })
})
