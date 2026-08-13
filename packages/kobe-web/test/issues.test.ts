import { describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/store.ts", () => ({ rpc: vi.fn() }))

import {
  canQuickStart,
  fetchProjects,
  filterIssues,
  groupByStatus,
  type Issue,
  ISSUE_STATUSES,
  issueMergePrompt,
  issueRepoOptions,
  overviewRows,
  projectChatPrompt,
  quickStartPrompt,
  type RepoIssues,
  resolveIssueRepoSelection,
} from "../src/lib/issues.ts"
import { rpc } from "../src/lib/store.ts"
import type { Task } from "../src/lib/types.ts"

/**
 * Pure helpers for the Issues panel: search/filter semantics, column
 * grouping + ordering, the cross-project overview math, and the
 * quick-start prompt contract (id + title + body + done instruction).
 */

const issue = (over: Partial<Issue>): Issue => ({
  id: over.id ?? 1,
  title: "",
  status: "open",
  created: "2026-06-01",
  body: "",
  ...over,
})

describe("ISSUE_STATUSES", () => {
  it("is the column order: open, doing, hold, done", () => {
    expect(ISSUE_STATUSES).toEqual(["open", "doing", "hold", "done"])
  })
})

describe("filterIssues — query", () => {
  const issues = [
    issue({ id: 1, title: "Fix daemon crash", body: "stack trace attached" }),
    issue({ id: 2, title: "Polish board", body: "chips and columns" }),
    issue({ id: 12, title: "Other", body: "" }),
  ]

  it("matches title and body case-insensitively", () => {
    expect(filterIssues(issues, { query: "DAEMON" }).map((i) => i.id)).toEqual(
      [1],
    )
    expect(filterIssues(issues, { query: "chips" }).map((i) => i.id)).toEqual(
      [2],
    )
  })

  it('matches the "#<id>" reference', () => {
    expect(filterIssues(issues, { query: "#12" }).map((i) => i.id)).toEqual([
      12,
    ])
    expect(filterIssues(issues, { query: "#2 " }).map((i) => i.id)).toEqual([
      2,
    ])
  })

  it("empty/whitespace query matches everything", () => {
    expect(filterIssues(issues, {})).toHaveLength(3)
    expect(filterIssues(issues, { query: "  " })).toHaveLength(3)
  })

  it("non-matching query yields nothing", () => {
    expect(filterIssues(issues, { query: "zzz-nope" })).toEqual([])
  })
})

describe("filterIssues — statuses", () => {
  const issues = [
    issue({ id: 1, status: "open" }),
    issue({ id: 2, status: "doing" }),
    issue({ id: 3, status: "hold" }),
    issue({ id: 4, status: "done" }),
  ]

  it("keeps only the listed statuses", () => {
    expect(
      filterIssues(issues, { statuses: ["hold", "done"] }).map((i) => i.id),
    ).toEqual([3, 4])
  })

  it("empty or undefined statuses means all", () => {
    expect(filterIssues(issues, { statuses: [] })).toHaveLength(4)
    expect(filterIssues(issues, {})).toHaveLength(4)
  })

  it("composes with the query", () => {
    const mixed = [
      issue({ id: 1, status: "open", title: "auth bug" }),
      issue({ id: 2, status: "done", title: "auth bug" }),
    ]
    expect(
      filterIssues(mixed, { query: "auth", statuses: ["open"] }).map(
        (i) => i.id,
      ),
    ).toEqual([1])
  })
})

describe("groupByStatus", () => {
  it("buckets into all four columns, empty arrays included", () => {
    const groups = groupByStatus([issue({ id: 1, status: "hold" })])
    expect(groups.hold.map((i) => i.id)).toEqual([1])
    expect(groups.open).toEqual([])
    expect(groups.doing).toEqual([])
    expect(groups.done).toEqual([])
  })

  it("sorts active columns newest-created first, then id desc", () => {
    const groups = groupByStatus([
      issue({ id: 1, status: "open", created: "2026-06-01" }),
      issue({ id: 5, status: "open", created: "2026-06-10" }),
      issue({ id: 3, status: "open", created: "2026-06-10" }),
    ])
    expect(groups.open.map((i) => i.id)).toEqual([5, 3, 1])
  })

  it("sorts done by id desc regardless of created", () => {
    const groups = groupByStatus([
      issue({ id: 2, status: "done", created: "2026-06-10" }),
      issue({ id: 9, status: "done", created: "2026-01-01" }),
    ])
    expect(groups.done.map((i) => i.id)).toEqual([9, 2])
  })
})

describe("overviewRows", () => {
  const repo = (
    repoRoot: string,
    issues: Issue[],
    exists = true,
  ): RepoIssues => ({ repoRoot, exists, nextId: 100, issues })

  it("counts per status, total, and openish = open+doing+hold", () => {
    const rows = overviewRows([
      repo("/u/p/kobe", [
        issue({ id: 1, status: "open" }),
        issue({ id: 2, status: "doing" }),
        issue({ id: 3, status: "hold" }),
        issue({ id: 4, status: "done" }),
      ]),
    ])
    expect(rows).toEqual([
      {
        repoRoot: "/u/p/kobe",
        counts: { open: 1, doing: 1, hold: 1, done: 1 },
        total: 4,
        openish: 3,
      },
    ])
  })

  it("sorts by openish desc, then repoRoot", () => {
    const rows = overviewRows([
      repo("/u/p/zeta", [issue({ id: 1, status: "open" })]),
      repo("/u/p/alpha", [issue({ id: 1, status: "open" })]),
      repo("/u/p/busy", [
        issue({ id: 1, status: "open" }),
        issue({ id: 2, status: "hold" }),
      ]),
      repo("/u/p/idle", [issue({ id: 1, status: "done" })]),
    ])
    expect(rows.map((r) => r.repoRoot)).toEqual([
      "/u/p/busy",
      "/u/p/alpha",
      "/u/p/zeta",
      "/u/p/idle",
    ])
  })

  it("a repo without an issues file contributes a zero row", () => {
    const rows = overviewRows([repo("/u/p/bare", [], false)])
    expect(rows[0].total).toBe(0)
    expect(rows[0].openish).toBe(0)
  })
})

describe("issueRepoOptions", () => {
  it("includes saved project repos even before they have tasks or issues", () => {
    expect(issueRepoOptions([], ["/Users/narwhal/proj/kobe"])).toEqual([
      { repo: "/Users/narwhal/proj/kobe", label: "kobe", count: 0 },
    ])
  })

  it("folds worktree tasks into their source repo instead of listing the worktree path", () => {
    const tasks = [
      {
        id: "main",
        repo: "/Users/narwhal/proj/kobe/",
        worktreePath: "/Users/narwhal/proj/kobe/",
        kind: "main",
        archived: false,
      },
      {
        id: "task",
        repo: "/Users/narwhal/proj/kobe/",
        worktreePath: "/Users/narwhal/.kobe/worktrees/kobe/bovid",
        kind: "task",
        archived: false,
      },
    ] as Task[]

    expect(issueRepoOptions(tasks)).toEqual([
      { repo: "/Users/narwhal/proj/kobe/", label: "kobe", count: 2 },
    ])
  })

  it("ignores archived tasks when building issue repo chips", () => {
    const tasks = [
      {
        id: "archived",
        repo: "/repo/old",
        worktreePath: "/repo/old",
        kind: "task",
        archived: true,
      },
    ] as Task[]

    expect(issueRepoOptions(tasks)).toEqual([])
  })

  it("ignores task repos that are not backed by a main project", () => {
    const tasks = [
      {
        id: "main",
        repo: "/Users/narwhal/proj/kobe/",
        worktreePath: "/Users/narwhal/proj/kobe/",
        kind: "main",
        archived: false,
      },
      {
        id: "bad-quickstart",
        repo: "/Users/narwhal/.kobe/worktrees/kobe/bovid",
        worktreePath: "/Users/narwhal/.kobe/worktrees/bovid/hawk",
        kind: "task",
        archived: false,
      },
    ] as Task[]

    expect(issueRepoOptions(tasks)).toEqual([
      { repo: "/Users/narwhal/proj/kobe/", label: "kobe", count: 1 },
    ])
  })

  it("bounds task counts to saved projects when saved projects are present", () => {
    const tasks = [
      {
        id: "good",
        repo: "/repo/known",
        worktreePath: "/repo/known/.kobe/worktrees/one",
        kind: "task",
        archived: false,
      },
      {
        id: "stray",
        repo: "/repo/stray",
        worktreePath: "/repo/stray/.kobe/worktrees/two",
        kind: "task",
        archived: false,
      },
    ] as Task[]

    expect(issueRepoOptions(tasks, ["/repo/known"])).toEqual([
      { repo: "/repo/known", label: "known", count: 1 },
    ])
  })
})

describe("fetchProjects", () => {
  it("loads saved project repos from the bridge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ projects: ["/repo/kobe", 42, "/repo/web"] }),
          ),
        ),
      ),
    )

    await expect(fetchProjects()).resolves.toEqual(["/repo/kobe", "/repo/web"])
    vi.unstubAllGlobals()
  })
})

describe("resolveIssueRepoSelection", () => {
  const options = [
    { repo: "/u/p/kobe", label: "kobe", count: 2 },
    { repo: "/u/p/web", label: "web", count: 1 },
  ]

  it("keeps a valid current project", () => {
    expect(resolveIssueRepoSelection(options, "/u/p/web")).toBe("/u/p/web")
  })

  it("falls back to the first project when current is empty or stale", () => {
    expect(resolveIssueRepoSelection(options, null)).toBe("/u/p/kobe")
    expect(resolveIssueRepoSelection(options, "/u/p/gone")).toBe("/u/p/kobe")
  })

  it("returns null when there are no projects", () => {
    expect(resolveIssueRepoSelection([], "/u/p/kobe")).toBeNull()
  })
})

describe("canQuickStart", () => {
  it("is true for everything except done", () => {
    for (const status of ISSUE_STATUSES) {
      expect(canQuickStart(status)).toBe(status !== "done")
    }
  })
})

describe("quickStartPrompt", () => {
  it("contains the issue reference, title, body, and done instruction", () => {
    const prompt = quickStartPrompt(
      issue({
        id: 42,
        title: "Wire the flux capacitor",
        body: "It needs 1.21 gigawatts.\nSee the schematic.",
      }),
    )
    expect(prompt).toContain("user story #42")
    expect(prompt).toContain("Wire the flux capacitor")
    expect(prompt).toContain("It needs 1.21 gigawatts.\nSee the schematic.")
    expect(prompt).toContain("dedicated Rove task session")
    expect(prompt).toContain("verify the acceptance criteria")
    expect(prompt).toContain(
      "merge the task branch back into the current project's main branch",
    )
    expect(prompt).toContain(
      "rove api issue-set-status --repo . --id 42 --status done",
    )
    // The caller flips to doing; the prompt must NOT tell the agent to.
    expect(prompt).not.toContain('"doing"')
  })

  it("omits the body section when the body is blank", () => {
    const prompt = quickStartPrompt(issue({ id: 7, title: "T", body: "  " }))
    expect(prompt).toContain("story #7")
    expect(prompt).not.toContain("\n\n\n")
  })
})

describe("issueMergePrompt", () => {
  it("asks the linked task to summarize, merge to project main, and mark the issue done", () => {
    const prompt = issueMergePrompt(issue({ id: 9, title: "Ship it" }))
    expect(prompt).toContain("Finish user story #9")
    expect(prompt).toContain("Verify the acceptance criteria")
    expect(prompt).toContain(
      "merge this task branch back into the current project's main branch",
    )
    expect(prompt).toContain(
      "rove api issue-set-status --repo . --id 9 --status done",
    )
  })
})

describe("projectChatPrompt", () => {
  it("frames the story without worktree/merge instructions", () => {
    const prompt = projectChatPrompt(
      issue({ id: 9, title: "Tune it", body: "the details" }),
      "kobe api",
    )
    expect(prompt).toContain("Work on user story #9: Tune it")
    expect(prompt).toContain("the details")
    expect(prompt).toContain("directly in the project checkout")
    expect(prompt).not.toContain("task worktree")
    expect(prompt).not.toContain("merge the task branch")
    expect(prompt).toContain(
      "kobe api issue-set-status --repo . --id 9 --status done",
    )
  })
})
