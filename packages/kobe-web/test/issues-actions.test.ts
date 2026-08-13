import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/store.ts", () => ({ rpc: vi.fn() }))
vi.mock("../src/lib/tabs.ts", () => ({ addTab: vi.fn(), ensureEngineTab: vi.fn() }))
vi.mock("../src/lib/terminal.ts", () => ({ sendPtyText: vi.fn() }))

import {
  type Issue,
  issueMergePrompt,
  linkIssue,
  projectChatPrompt,
  promptIssueMerge,
  quickStartIssue,
  quickStartPrompt,
  type RepoIssues,
  startIssueChat,
  unlinkIssue,
} from "../src/lib/issues.ts"
import { rpc } from "../src/lib/store.ts"
import { addTab, ensureEngineTab } from "../src/lib/tabs.ts"
import { sendPtyText } from "../src/lib/terminal.ts"

const issue = (over: Partial<Issue>): Issue => ({
  id: over.id ?? 1,
  title: "",
  status: "open",
  created: "2026-06-01",
  body: "",
  ...over,
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
    vi.mocked(rpc).mockImplementation(async (name) => (name === "task.create" ? { taskId: "task-1" } : {}))
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

    await expect(quickStartIssue("/u/p/kobe", target)).resolves.toEqual({ taskId: "task-1" })
    expect(rpc).toHaveBeenCalledWith("task.create", { repo: "/u/p/kobe", title: "#3 Fix it", vendor: "codex" })
    expect(rpc).toHaveBeenCalledWith("task.setActive", { taskId: "task-1" })
    expect(rpc).not.toHaveBeenCalledWith("task.ensureWorktree", expect.anything())
    expect(ensureEngineTab).toHaveBeenCalledWith("task-1")
    expect(sendPtyText).toHaveBeenCalledWith("tab-1", "task-1", quickStartPrompt(target, "bun ./src/cli/index.ts api"))
    const issuesPost = fetchMock.mock.calls.find(
      ([url, opts]) => url === "/api/issues" && (opts as RequestInit | undefined)?.method === "POST",
    )
    expect(issuesPost).toBeDefined()
    const body = JSON.parse((issuesPost?.[1] as RequestInit).body as string) as { repoRoot: string; op: unknown }
    expect(body).toEqual({ repoRoot: "/u/p/kobe", op: { type: "link", id: 3, taskId: "task-1" } })
    expect(fetchMock).not.toHaveBeenCalledWith("/api/issues/sync-worktree", expect.anything())
    vi.unstubAllGlobals()
  })

  it("uses an explicit vendor arg over the Settings default", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => (name === "task.create" ? { taskId: "task-9" } : {}))
    vi.mocked(ensureEngineTab).mockReturnValue("tab-9")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url === "/api/settings" ? { defaultEngine: "codex" } : { api: "kobe api" })))))
    await quickStartIssue("/u/p/kobe", target, "claude")
    expect(rpc).toHaveBeenCalledWith("task.create", { repo: "/u/p/kobe", title: "#3 Fix it", vendor: "claude" })
    vi.unstubAllGlobals()
  })

  it("forwards the chosen effort under the create payload's effort key", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => (name === "task.create" ? { taskId: "task-e" } : {}))
    vi.mocked(ensureEngineTab).mockReturnValue("tab-e")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url === "/api/settings" ? { defaultEngine: "codex" } : { api: "kobe api" })))))
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
    vi.mocked(rpc).mockImplementation(async (name) => (name === "task.create" ? { taskId: "task-2" } : {}))
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
    await expect(quickStartIssue("/u/p/kobe", target)).resolves.toEqual({ taskId: "task-2" })
    expect(sendPtyText).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("falls back to daemon defaults when settings cannot be read", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => (name === "task.create" ? { taskId: "task-3" } : {}))
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
    expect(rpc).toHaveBeenCalledWith("task.create", { repo: "/u/p/kobe", title: "#3 Fix it" })
    vi.unstubAllGlobals()
  })

  it("surfaces a task.create failure and sends nothing", async () => {
    vi.mocked(rpc).mockRejectedValue(new Error("daemon unreachable"))
    vi.stubGlobal("fetch", vi.fn())
    await expect(quickStartIssue("/u/p/kobe", target)).rejects.toThrow("daemon unreachable")
    expect(rpc).not.toHaveBeenCalledWith("task.setActive", expect.anything())
    expect(ensureEngineTab).not.toHaveBeenCalled()
    expect(sendPtyText).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("startIssueChat placement=task delegates to the classic quick start", async () => {
    vi.mocked(rpc).mockImplementation(async (name) => (name === "task.create" ? { taskId: "task-d" } : {}))
    vi.mocked(ensureEngineTab).mockReturnValue("tab-d")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ api: "kobe api" })))))
    await expect(startIssueChat("/u/p/kobe", target, { vendor: "claude" })).resolves.toEqual({
      taskId: "task-d",
      workspaceTaskId: "task-d",
    })
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
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url === "/api/settings" ? { defaultEngine: "codex" } : { api: "kobe api" })))))
    await expect(
      startIssueChat("/u/p/kobe", target, { vendor: "claude", placement: "projectWorktree" }),
    ).resolves.toEqual({ taskId: "task-w", workspaceTaskId: "main-1" })
    expect(rpc).toHaveBeenCalledWith("task.ensureMain", { repo: "/u/p/kobe" })
    expect(addTab).toHaveBeenCalledWith("main-1", "task-w")
    expect(sendPtyText).toHaveBeenCalledWith("tab-w", "task-w", quickStartPrompt(target, "kobe api"))
    expect(rpc).toHaveBeenCalledWith("task.setActive", { taskId: "main-1" })
    expect(ensureEngineTab).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("placement=project spawns on the main task with no worktree and no link", async () => {
    vi.mocked(rpc).mockImplementation(async (name) =>
      name === "task.ensureMain" ? { task: { id: "main-2" } } : {},
    )
    vi.mocked(addTab).mockReturnValue("tab-p")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: true })
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(url === "/api/cli-invocation" ? { api: "kobe api" } : {}))),
    )
    vi.stubGlobal("fetch", fetchMock)
    await expect(startIssueChat("/u/p/kobe", target, { vendor: "claude", placement: "project" })).resolves.toEqual({
      taskId: "main-2",
      workspaceTaskId: "main-2",
    })
    expect(rpc).not.toHaveBeenCalledWith("task.create", expect.anything())
    expect(rpc).toHaveBeenCalledWith("task.setVendor", { taskId: "main-2", vendor: "claude" })
    expect(addTab).toHaveBeenCalledWith("main-2")
    expect(sendPtyText).toHaveBeenCalledWith("tab-p", "main-2", projectChatPrompt(target, "kobe api"))
    const issuesPost = fetchMock.mock.calls.find(
      ([url, opts]) => url === "/api/issues" && (opts as RequestInit | undefined)?.method === "POST",
    )
    expect(issuesPost).toBeDefined()
    const body = JSON.parse((issuesPost?.[1] as RequestInit).body as string) as { op: unknown }
    expect(body.op).toEqual({ type: "setStatus", id: 3, status: "doing" })
    vi.unstubAllGlobals()
  })

  it("inserts the finish/merge prompt into an existing linked task", async () => {
    vi.mocked(ensureEngineTab).mockReturnValue("tab-merge")
    vi.mocked(sendPtyText).mockResolvedValue({ spawned: false })
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ api: "bun ./src/cli/index.ts api" })))))
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
      JSON.stringify({ repoRoot: "/u/p/kobe", exists: true, nextId: 5, issues: [] } satisfies RepoIssues),
    )

  it("posts a {type:'link'} op carrying id + taskId", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(okResponse()))
    vi.stubGlobal("fetch", fetchMock)
    const state = await linkIssue("/u/p/kobe", 7, "task-7")
    expect(state.repoRoot).toBe("/u/p/kobe")
    expect(fetchMock).toHaveBeenCalledWith("/api/issues", expect.objectContaining({ method: "POST" }))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ repoRoot: "/u/p/kobe", op: { type: "link", id: 7, taskId: "task-7" } })
    vi.unstubAllGlobals()
  })

  it("posts a {type:'unlink'} op carrying id", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(okResponse()))
    vi.stubGlobal("fetch", fetchMock)
    await unlinkIssue("/u/p/kobe", 7)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ repoRoot: "/u/p/kobe", op: { type: "unlink", id: 7 } })
    vi.unstubAllGlobals()
  })

  it("throws with the bridge's detail on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))))
    await expect(linkIssue("/u/p/kobe", 7, "task-7")).rejects.toThrow(/update issues/)
    vi.unstubAllGlobals()
  })
})
