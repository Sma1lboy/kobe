import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/store.ts", () => ({ rpc: vi.fn() }))
vi.mock("../src/lib/tabs.ts", () => ({ ensureEngineTab: vi.fn() }))
vi.mock("../src/lib/terminal.ts", () => ({ sendPtyText: vi.fn() }))

import {
  canQuickStart,
  filterIssues,
  groupByStatus,
  type Issue,
  ISSUE_STATUSES,
  overviewRows,
  quickStartIssue,
  quickStartPrompt,
  type RepoIssues,
  statusActions,
} from "../src/lib/issues.ts"
import { rpc } from "../src/lib/store.ts"
import { ensureEngineTab } from "../src/lib/tabs.ts"
import { sendPtyText } from "../src/lib/terminal.ts"

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

describe("statusActions", () => {
  it("is the full transition table — every status has an exit path", () => {
    expect(statusActions("open")).toEqual([
      { label: "Start", to: "doing" },
      { label: "Hold", to: "hold" },
      { label: "Done", to: "done" },
    ])
    expect(statusActions("doing")).toEqual([
      { label: "Hold", to: "hold" },
      { label: "Done", to: "done" },
    ])
    expect(statusActions("hold")).toEqual([
      { label: "Resume", to: "open" },
      { label: "Done", to: "done" },
    ])
    expect(statusActions("done")).toEqual([{ label: "Reopen", to: "open" }])
    for (const status of ISSUE_STATUSES) {
      expect(statusActions(status).length).toBeGreaterThan(0)
    }
  })

  it("never offers a self-move", () => {
    for (const status of ISSUE_STATUSES) {
      for (const action of statusActions(status)) {
        expect(action.to).not.toBe(status)
      }
    }
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
    expect(prompt).toContain("kobe issue #42")
    expect(prompt).toContain("Wire the flux capacitor")
    expect(prompt).toContain("It needs 1.21 gigawatts.\nSee the schematic.")
    expect(prompt).toContain("kobe api issue-set-status --repo . --id 42 --status done")
    // The caller flips to doing; the prompt must NOT tell the agent to.
    expect(prompt).not.toContain('"doing"')
  })

  it("omits the body section when the body is blank", () => {
    const prompt = quickStartPrompt(issue({ id: 7, title: "T", body: "  " }))
    expect(prompt).toContain("issue #7")
    expect(prompt).not.toContain("\n\n\n")
  })
})

describe("quickStartIssue", () => {
  const target = issue({ id: 3, title: "Fix it", body: "details" })

  beforeEach(() => {
    vi.mocked(rpc).mockReset()
    vi.mocked(ensureEngineTab).mockReset()
    vi.mocked(sendPtyText).mockReset()
  })

  it("creates the task, flips to doing, and delivers the prompt", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => {
      if (name === "task.create") return { taskId: "task-1" }
      return {}
    })
    vi.mocked(ensureEngineTab).mockReturnValue("tab-1")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url === "/api/settings" ? { defaultEngine: "codex" } : {},
          ),
        ),
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await quickStartIssue("/u/p/kobe", target)
    expect(result).toEqual({ taskId: "task-1" })
    // No branch; vendor follows Settings' default engine.
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
      quickStartPrompt(target),
    )
    // The doing flip went through the issues POST route.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/issues",
      expect.objectContaining({ method: "POST" }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith("/api/issues/sync-worktree", expect.anything())
    vi.unstubAllGlobals()
  })

  it("survives a failed status flip (task already exists)", async () => {
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
          : Promise.reject(new Error("bridge down")),
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
})
