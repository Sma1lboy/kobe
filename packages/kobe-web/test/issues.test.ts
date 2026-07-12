import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/store.ts", () => ({ rpc: vi.fn() }))
vi.mock("../src/lib/tabs.ts", () => ({
  addTab: vi.fn(),
  ensureEngineTab: vi.fn(),
}))
vi.mock("../src/lib/terminal.ts", () => ({ sendPtyText: vi.fn() }))

import {
  canQuickStart,
  fetchProjects,
  filterIssues,
  groupByStatus,
  type Issue,
  ISSUE_STATUSES,
  issueMergePrompt,
  issueRepoOptions,
  linkIssue,
  overviewRows,
  projectChatPrompt,
  promptIssueMerge,
  quickStartIssue,
  quickStartPrompt,
  type RepoIssues,
  resolveIssueRepoSelection,
  startIssueChat,
  unlinkIssue,
} from "../src/lib/issues.ts"
import { rpc } from "../src/lib/store.ts"
import { addTab, ensureEngineTab } from "../src/lib/tabs.ts"
import { sendPtyText } from "../src/lib/terminal.ts"
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
    expect(prompt).toContain("dedicated kobe task session")
    expect(prompt).toContain("verify the acceptance criteria")
    expect(prompt).toContain(
      "merge the task branch back into the current project's main branch",
    )
    expect(prompt).toContain(
      "kobe api issue-set-status --repo . --id 42 --status done",
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
      "kobe api issue-set-status --repo . --id 9 --status done",
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

describe("quickStartIssue", () => {
  const target = issue({ id: 3, title: "Fix it", body: "details" })

  beforeEach(() => {
    vi.mocked(rpc).mockReset()
    vi.mocked(addTab).mockReset()
    vi.mocked(ensureEngineTab).mockReset()
    vi.mocked(sendPtyText).mockReset()
  })

  it("creates the task (no issueId — link is one-way), links the issue, delivers the prompt", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.create") return { taskId: "task-1" }
      return {}
    })
    vi.mocked(ensureEngineTab).mockReturnValue("tab-1")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url === "/api/settings"
              ? { defaultEngine: "codex" }
              : url === "/api/cli-invocation"
                ? { api: "bun ./src/cli/index.ts api" }
                : {},
          ),
        ),
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await quickStartIssue("/u/p/kobe", target)
    expect(result).toEqual({ taskId: "task-1" })
    // No branch; vendor follows Settings' default engine. Task.issueId was
    // dropped — the create payload no longer carries an issueId; Issue.taskId
    // (set by the link op below) is the only link.
    expect(rpc).toHaveBeenCalledWith("task.create", {
      repo: "/u/p/kobe",
      title: "#3 Fix it",
      vendor: "codex",
    })
    // The daemon's active-task pointer follows, like every open-task path.
    expect(rpc).toHaveBeenCalledWith("task.setActive", { taskId: "task-1" })
    expect(rpc).not.toHaveBeenCalledWith("task.ensureWorktree", expect.anything())
    expect(ensureEngineTab).toHaveBeenCalledWith("task-1")
    expect(sendPtyText).toHaveBeenCalledWith(
      "tab-1",
      "task-1",
      quickStartPrompt(target, "bun ./src/cli/index.ts api"),
    )
    // The link went through the issues POST route as a {type:"link"} op
    // carrying the new taskId (flips status doing + arms the daemon mirror).
    const issuesPost = fetchMock.mock.calls.find(
      ([url, opts]) =>
        url === "/api/issues" &&
        (opts as RequestInit | undefined)?.method === "POST",
    )
    expect(issuesPost).toBeDefined()
    const body = JSON.parse(
      (issuesPost?.[1] as RequestInit).body as string,
    ) as { repoRoot: string; op: unknown }
    expect(body).toEqual({
      repoRoot: "/u/p/kobe",
      op: { type: "link", id: 3, taskId: "task-1" },
    })
    expect(fetchMock).not.toHaveBeenCalledWith("/api/issues/sync-worktree", expect.anything())
    vi.unstubAllGlobals()
  })

  it("uses an explicit vendor arg over the Settings default", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.create") return { taskId: "task-9" }
      return {}
    })
    vi.mocked(ensureEngineTab).mockReturnValue("tab-9")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/api/settings"
          ? Promise.resolve(
              new Response(JSON.stringify({ defaultEngine: "codex" })),
            )
          : Promise.resolve(new Response(JSON.stringify({ api: "kobe api" }))),
      ),
    )

    await quickStartIssue("/u/p/kobe", target, "claude")
    // Drawer-chosen engine wins; Settings is not even read for the vendor.
    expect(rpc).toHaveBeenCalledWith("task.create", {
      repo: "/u/p/kobe",
      title: "#3 Fix it",
      vendor: "claude",
    })
    vi.unstubAllGlobals()
  })

  it("forwards the chosen effort under the create payload's effort key", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.create") return { taskId: "task-e" }
      return {}
    })
    vi.mocked(ensureEngineTab).mockReturnValue("tab-e")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/api/settings"
          ? Promise.resolve(
              new Response(JSON.stringify({ defaultEngine: "codex" })),
            )
          : Promise.resolve(new Response(JSON.stringify({ api: "kobe api" }))),
      ),
    )

    await quickStartIssue("/u/p/kobe", target, "codex", "high")
    expect(rpc).toHaveBeenCalledWith("task.create", {
      repo: "/u/p/kobe",
      title: "#3 Fix it",
      vendor: "codex",
      effort: "high",
    })
    vi.unstubAllGlobals()
  })

  it("survives a failed link (task already exists)", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.create") return { taskId: "task-2" }
      return {}
    })
    vi.mocked(ensureEngineTab).mockReturnValue("tab-2")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: false })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/api/settings"
          ? Promise.resolve(new Response(JSON.stringify({ defaultEngine: "claude" })))
          : url === "/api/issues"
            ? Promise.reject(new Error("bridge down"))
            : Promise.resolve(new Response(JSON.stringify({ api: "kobe api" }))),
      ),
    )

    await expect(quickStartIssue("/u/p/kobe", target)).resolves.toEqual({
      taskId: "task-2",
    })
    expect(sendPtyText).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("falls back to daemon defaults when settings cannot be read", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.create") return { taskId: "task-3" }
      return {}
    })
    vi.mocked(ensureEngineTab).mockReturnValue("tab-3")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/api/settings"
          ? Promise.resolve(new Response("nope", { status: 500 }))
          : url === "/api/cli-invocation"
            ? Promise.resolve(new Response(JSON.stringify({ api: "kobe api" })))
          : Promise.resolve(new Response(JSON.stringify({}))),
      ),
    )

    await quickStartIssue("/u/p/kobe", target)
    expect(rpc).toHaveBeenCalledWith("task.create", {
      repo: "/u/p/kobe",
      title: "#3 Fix it",
    })
    vi.unstubAllGlobals()
  })

  it("surfaces a task.create failure and sends nothing", async () => {
    vi.mocked(rpc).mockRejectedValue(new Error("daemon unreachable"))
    vi.stubGlobal("fetch", vi.fn())

    await expect(quickStartIssue("/u/p/kobe", target)).rejects.toThrow(
      "daemon unreachable",
    )
    // task.create failed, so there's no task to point the daemon at.
    expect(rpc).not.toHaveBeenCalledWith(
      "task.setActive",
      expect.anything(),
    )
    expect(ensureEngineTab).not.toHaveBeenCalled()
    expect(sendPtyText).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("startIssueChat placement=task delegates to the classic quick start", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.create") return { taskId: "task-d" }
      return {}
    })
    vi.mocked(ensureEngineTab).mockReturnValue("tab-d")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ api: "kobe api" }))),
      ),
    )

    await expect(
      startIssueChat("/u/p/kobe", target, { vendor: "claude" }),
    ).resolves.toEqual({ taskId: "task-d", workspaceTaskId: "task-d" })
    expect(rpc).not.toHaveBeenCalledWith("task.ensureMain", expect.anything())
    expect(addTab).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("placement=projectWorktree pins the new task's tab in the project workspace", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.create") return { taskId: "task-w" }
      if (name === "task.ensureMain") return { task: { id: "main-1" } }
      return {}
    })
    vi.mocked(addTab).mockReturnValue("tab-w")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url === "/api/settings" ? { defaultEngine: "codex" } : { api: "kobe api" },
            ),
          ),
        ),
      ),
    )

    const result = await startIssueChat("/u/p/kobe", target, {
      vendor: "claude",
      placement: "projectWorktree",
    })
    // The engine lives in the NEW worktree task; navigation targets the project.
    expect(result).toEqual({ taskId: "task-w", workspaceTaskId: "main-1" })
    expect(rpc).toHaveBeenCalledWith("task.ensureMain", { repo: "/u/p/kobe" })
    // Tab bucket = the project's main task, engine override = the new task.
    expect(addTab).toHaveBeenCalledWith("main-1", "task-w")
    expect(sendPtyText).toHaveBeenCalledWith(
      "tab-w",
      "task-w",
      quickStartPrompt(target, "kobe api"),
    )
    // The active pointer follows where the user lands (the project).
    expect(rpc).toHaveBeenCalledWith("task.setActive", { taskId: "main-1" })
    expect(ensureEngineTab).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("placement=project spawns on the main task with no worktree and no link", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.ensureMain") return { task: { id: "main-2" } }
      return {}
    })
    vi.mocked(addTab).mockReturnValue("tab-p")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify(url === "/api/cli-invocation" ? { api: "kobe api" } : {}),
        ),
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await startIssueChat("/u/p/kobe", target, {
      vendor: "claude",
      placement: "project",
    })
    expect(result).toEqual({ taskId: "main-2", workspaceTaskId: "main-2" })
    // No worktree task, no issue link — the chosen vendor is stamped on the
    // main task before spawn-on-send reads it from engine-spec.
    expect(rpc).not.toHaveBeenCalledWith("task.create", expect.anything())
    expect(rpc).toHaveBeenCalledWith("task.setVendor", {
      taskId: "main-2",
      vendor: "claude",
    })
    expect(addTab).toHaveBeenCalledWith("main-2")
    expect(sendPtyText).toHaveBeenCalledWith(
      "tab-p",
      "main-2",
      projectChatPrompt(target, "kobe api"),
    )
    // The story flips `doing` via a setStatus op (no link op exists).
    const issuesPost = fetchMock.mock.calls.find(
      ([url, opts]) =>
        url === "/api/issues" &&
        (opts as RequestInit | undefined)?.method === "POST",
    )
    expect(issuesPost).toBeDefined()
    const body = JSON.parse(
      (issuesPost?.[1] as RequestInit).body as string,
    ) as { op: { type: string; status?: string } }
    expect(body.op).toEqual({ type: "setStatus", id: 3, status: "doing" })
    vi.unstubAllGlobals()
  })

  it("inserts the finish/merge prompt into an existing linked task", async () => {
    vi.mocked(ensureEngineTab).mockReturnValue("tab-merge")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: false })
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ api: "bun ./src/cli/index.ts api" })),
        ),
      ),
    )

    await promptIssueMerge("task-9", target)

    expect(ensureEngineTab).toHaveBeenCalledWith("task-9")
    expect(sendPtyText).toHaveBeenCalledWith(
      "tab-merge",
      "task-9",
      issueMergePrompt(target, "bun ./src/cli/index.ts api"),
    )
    vi.unstubAllGlobals()
  })
})

describe("linkIssue / unlinkIssue", () => {
  const okResponse = (): Response =>
    new Response(
      JSON.stringify({
        repoRoot: "/u/p/kobe",
        exists: true,
        nextId: 5,
        issues: [],
      } satisfies RepoIssues),
    )

  it("posts a {type:'link'} op carrying id + taskId", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(okResponse()),
    )
    vi.stubGlobal("fetch", fetchMock)

    const state = await linkIssue("/u/p/kobe", 7, "task-7")
    expect(state.repoRoot).toBe("/u/p/kobe")
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/issues",
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({
      repoRoot: "/u/p/kobe",
      op: { type: "link", id: 7, taskId: "task-7" },
    })
    vi.unstubAllGlobals()
  })

  it("posts a {type:'unlink'} op carrying id", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(okResponse()),
    )
    vi.stubGlobal("fetch", fetchMock)

    await unlinkIssue("/u/p/kobe", 7)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({
      repoRoot: "/u/p/kobe",
      op: { type: "unlink", id: 7 },
    })
    vi.unstubAllGlobals()
  })

  it("throws with the bridge's detail on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("nope", { status: 500 })),
      ),
    )
    await expect(linkIssue("/u/p/kobe", 7, "task-7")).rejects.toThrow(
      /update issues/,
    )
    vi.unstubAllGlobals()
  })
})
