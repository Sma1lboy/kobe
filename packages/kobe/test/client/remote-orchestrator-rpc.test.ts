import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RemoteOrchestrator } from "../../src/client/remote-orchestrator.ts"

const serializedTask = {
  id: "t1",
  title: "task",
  repo: "/repo",
  branch: "kobe/t1",
  status: "in_progress",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function fakeClient() {
  const request = vi.fn(async (method: string) => {
    if (method === "task.ensureWorktree") return { worktreePath: "/wt" }
    if (method === "worktree.discoverAdoptable") return { worktrees: [] }
    if (method.startsWith("task.") || method === "worktree.adopt") return { task: serializedTask }
    return {}
  })
  const client = {
    on: () => () => {},
    onLifecycle: () => () => {},
    request,
  } as unknown as KobeDaemonClient
  return { client, request }
}

let orch: RemoteOrchestrator
let request: ReturnType<typeof fakeClient>["request"]

beforeEach(() => {
  const fake = fakeClient()
  orch = new RemoteOrchestrator(fake.client)
  request = fake.request
})

describe("RemoteOrchestrator RPC wire mapping", () => {
  it("createTask remaps modelEffort to the wire's `effort`", async () => {
    await orch.createTask({ repo: "/repo", title: "t", baseRef: "main", vendor: "claude", modelEffort: "high" })
    expect(request).toHaveBeenCalledWith("task.create", {
      repo: "/repo",
      title: "t",
      baseRef: "main",
      vendor: "claude",
      effort: "high",
    })
    const payload = (request.mock.calls[0] as unknown[])?.[1] as Record<string, unknown>
    expect("modelEffort" in payload).toBe(false)
  })

  it("ensureMainTask / ensureWorktree / forgetProject", async () => {
    await orch.ensureMainTask("/repo")
    expect(request).toHaveBeenCalledWith("task.ensureMain", { repo: "/repo" })
    await expect(orch.ensureWorktree("t1")).resolves.toBe("/wt")
    expect(request).toHaveBeenCalledWith("task.ensureWorktree", { taskId: "t1" })
    await orch.forgetProject("/repo")
    expect(request).toHaveBeenCalledWith("project.forget", { repo: "/repo" })
  })

  it("task mutators map to their daemon verbs with stringified ids", async () => {
    await orch.setTitle("t1", "New")
    expect(request).toHaveBeenCalledWith("task.rename", { taskId: "t1", title: "New" })
    await orch.setBranch("t1", "feat/x")
    expect(request).toHaveBeenCalledWith("task.setBranch", { taskId: "t1", branch: "feat/x" })
    await orch.setVendor("t1", "codex")
    expect(request).toHaveBeenCalledWith("task.setVendor", { taskId: "t1", vendor: "codex" })
    await orch.setPinned("t1", true)
    expect(request).toHaveBeenCalledWith("task.pin", { taskId: "t1", pinned: true })
    await orch.setArchived("t1", true)
    expect(request).toHaveBeenCalledWith("task.archive", { taskId: "t1", archived: true })
    await orch.setStatus("t1", "in_review")
    expect(request).toHaveBeenCalledWith("task.status", { taskId: "t1", status: "in_review" })
    await orch.deleteTask("t1", { force: true })
    expect(request).toHaveBeenCalledWith("task.delete", { taskId: "t1", force: true })
  })

  it("moveTask translates the signed delta to an up/down direction", async () => {
    await orch.moveTask("t1", -1)
    expect(request).toHaveBeenCalledWith("task.move", { taskId: "t1", direction: "up" })
    await orch.moveTask("t1", 1)
    expect(request).toHaveBeenCalledWith("task.move", { taskId: "t1", direction: "down" })
  })

  it("worktree adoption RPCs", async () => {
    await expect(orch.discoverAdoptableWorktrees("/repo")).resolves.toEqual([])
    expect(request).toHaveBeenCalledWith("worktree.discoverAdoptable", { repo: "/repo" })
    await orch.adoptWorktree({ repo: "/repo", worktreePath: "/wt", branch: "b" })
    expect(request).toHaveBeenCalledWith("worktree.adopt", { repo: "/repo", worktreePath: "/wt", branch: "b" })
  })

  it("setActiveTask passes null through for 'no active task'", async () => {
    await orch.setActiveTask("t1")
    expect(request).toHaveBeenCalledWith("task.setActive", { taskId: "t1" })
    await orch.setActiveTask(null)
    expect(request).toHaveBeenCalledWith("task.setActive", { taskId: null })
  })

  it("subscribeTasks delivers the current snapshot eagerly and survives a throwing listener", async () => {
    const listener = vi.fn(() => {
      throw new Error("listener boom")
    })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const unsubscribe = orch.subscribeTasks(listener)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith([])
    unsubscribe()
    errSpy.mockRestore()
  })

  it("getTask finds by id from the current snapshot", () => {
    expect(orch.getTask("nope")).toBeUndefined()
    expect(orch.listTasks()).toEqual([])
  })
})
