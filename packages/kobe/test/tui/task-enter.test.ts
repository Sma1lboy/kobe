/**
 * Behavioral tests for the Handover owner (`src/tui/lib/task-enter.ts`):
 * `ensureTaskSession`'s build/preview/materialise branches, `enterTask`'s
 * heal/zen/supersede sequencing, and the `HandoverError` phases the callers
 * toast on. Everything IO-shaped (tmux client, terminal/tmux applier, state
 * gates, engine command) is mocked at the module seams the production code
 * imports — no tmux, no daemon, no state.json.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"

const state = vi.hoisted(() => ({
  existingSessions: new Set<string>(),
  usableWorktrees: new Set<string>(),
  archivedPreviewOn: false,
  previewTasks: new Set<string>(),
  sessionOptions: {} as Record<string, string>,
  currentSession: null as string | null,
  ensureSessionOk: true,
  ensureSessionCalls: [] as Record<string, unknown>[],
}))

vi.mock("../../src/tmux/client", () => ({
  tmuxSessionName: (id: string) => `kobe-${id}`,
  sessionExists: vi.fn(async (name: string) => state.existingSessions.has(name)),
  getSessionOption: vi.fn(async (_s: string, option: string) => state.sessionOptions[option] ?? ""),
}))
vi.mock("../../src/exec/resolve", () => ({
  worktreeUsable: (p: string) => state.usableWorktrees.has(p),
}))
vi.mock("../../src/engine/interactive-command", () => ({
  interactiveEngineCommand: (vendor: string | undefined) => [vendor ?? "claude"],
}))
vi.mock("../../src/state/archived-history", () => ({
  archivedHistoryPreviewEnabled: () => state.archivedPreviewOn,
}))
vi.mock("../../src/state/preview-mode", () => ({
  previewModeEnabled: (taskId: string) => state.previewTasks.has(taskId),
}))
vi.mock("../../src/state/repo-init", () => ({
  resolveEngineLaunchInit: vi.fn((_repo: string, _wt: string, opts: { kind: string }) =>
    opts.kind === "repo-init" ? { initScript: "init.sh" } : undefined,
  ),
}))
vi.mock("../../src/tui/panes/terminal/tmux", () => ({
  ensureSession: vi.fn(async (opts: Record<string, unknown>) => {
    state.ensureSessionCalls.push(opts)
    return state.ensureSessionOk
  }),
  currentSessionName: vi.fn(async () => state.currentSession),
  captureGlobalLayout: vi.fn(async () => {}),
  enterWindow: vi.fn(async () => {}),
}))
vi.mock("../../src/tui/panes/terminal/layout-zen", () => ({
  syncSessionZen: vi.fn(async () => {}),
}))

const { HandoverError, ensureTaskSession, enterTask, jumpToTask } = await import("../../src/tui/lib/task-enter")
const tmuxApplier = await import("../../src/tui/panes/terminal/tmux")
const layoutZen = await import("../../src/tui/panes/terminal/layout-zen")
const repoInit = await import("../../src/state/repo-init")

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: toTaskId("t1"),
    title: "my task",
    repo: "/repo",
    worktreePath: "/wt",
    archived: false,
    ...overrides,
  } as unknown as Task
}

type FakeOrch = {
  ensureWorktree: ReturnType<typeof vi.fn>
  setActiveTask: ReturnType<typeof vi.fn>
}

type OrchArg = Parameters<typeof ensureTaskSession>[0]

function makeOrch(): FakeOrch {
  return {
    ensureWorktree: vi.fn(async () => "/materialised-wt"),
    setActiveTask: vi.fn(async () => {}),
  }
}

function resetState(): void {
  state.existingSessions = new Set()
  state.usableWorktrees = new Set(["/wt", "/repo", "/materialised-wt"])
  state.archivedPreviewOn = false
  state.previewTasks = new Set()
  state.sessionOptions = {}
  state.currentSession = null
  state.ensureSessionOk = true
  state.ensureSessionCalls = []
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("ensureTaskSession", () => {
  test("returns true without building when the session already exists", async () => {
    state.existingSessions = new Set(["kobe-t1"])
    const result = await ensureTaskSession(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude")
    expect(result).toBe(true)
    expect(state.ensureSessionCalls).toEqual([])
  })

  test("builds a fresh live-engine session with the repo init weave when includeInitPrompt", async () => {
    const result = await ensureTaskSession(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude", {
      includeInitPrompt: true,
    })
    expect(result).toBe(false)
    expect(state.ensureSessionCalls).toHaveLength(1)
    expect(state.ensureSessionCalls[0]).toMatchObject({
      name: "kobe-t1",
      cwd: "/wt",
      taskId: "t1",
      vendor: "claude",
      repo: "/repo",
      launchInit: { initScript: "init.sh" },
    })
    expect(repoInit.resolveEngineLaunchInit).toHaveBeenCalledWith("/repo", "/wt", { kind: "repo-init" })
  })

  test("omits the init weave when the caller delivers its own prompt", async () => {
    await ensureTaskSession(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude")
    expect(repoInit.resolveEngineLaunchInit).toHaveBeenCalledWith("/repo", "/wt", { kind: "none" })
    expect(state.ensureSessionCalls[0]).toMatchObject({ launchInit: undefined })
  })

  test("materialises a missing worktree via the daemon and calls reload", async () => {
    state.usableWorktrees = new Set(["/materialised-wt", "/repo"])
    const orch = makeOrch()
    const reload = vi.fn()
    await ensureTaskSession(orch as unknown as OrchArg, makeTask({ worktreePath: undefined }), "/repo", "claude", {
      reload,
    })
    expect(orch.ensureWorktree).toHaveBeenCalledWith("t1")
    expect(reload).toHaveBeenCalled()
    expect(state.ensureSessionCalls[0]).toMatchObject({ cwd: "/materialised-wt" })
  })

  test("throws no-daemon when the worktree is missing and there is no orchestrator", async () => {
    state.usableWorktrees = new Set()
    await expect(
      ensureTaskSession(null, makeTask({ worktreePath: undefined }), "/repo", "claude"),
    ).rejects.toMatchObject({ name: "HandoverError", phase: "no-daemon" })
  })

  test("wraps an ensureWorktree failure as a worktree-phase HandoverError with cause", async () => {
    state.usableWorktrees = new Set()
    const orch = makeOrch()
    const boom = new Error("git blew up")
    orch.ensureWorktree.mockRejectedValue(boom)
    const err = await ensureTaskSession(
      orch as unknown as OrchArg,
      makeTask({ worktreePath: undefined }),
      "/repo",
      "claude",
    ).catch((e) => e)
    expect(err).toBeInstanceOf(HandoverError)
    expect(err.phase).toBe("worktree")
    expect(err.cause).toBe(boom)
  })

  test("throws worktree when even the materialised path is unusable", async () => {
    state.usableWorktrees = new Set()
    const orch = makeOrch()
    orch.ensureWorktree.mockResolvedValue("/still-broken")
    await expect(
      ensureTaskSession(orch as unknown as OrchArg, makeTask({ worktreePath: undefined }), "/repo", "claude"),
    ).rejects.toMatchObject({ phase: "worktree" })
  })

  test("throws session when the session build fails", async () => {
    state.ensureSessionOk = false
    await expect(
      ensureTaskSession(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude"),
    ).rejects.toMatchObject({
      phase: "session",
    })
  })

  test("archived task + beta gate opens the read-only history session without materialising", async () => {
    state.archivedPreviewOn = true
    state.usableWorktrees = new Set(["/repo"]) // recorded worktree GONE, repo usable
    const orch = makeOrch()
    const result = await ensureTaskSession(
      orch as unknown as OrchArg,
      makeTask({ archived: true, worktreePath: "/gone" }),
      "/repo",
      "claude",
    )
    expect(result).toBe(false)
    expect(orch.ensureWorktree).not.toHaveBeenCalled()
    // spawn dir falls back to the repo, history keys by the RECORDED path
    expect(state.ensureSessionCalls[0]).toMatchObject({
      archived: true,
      cwd: "/repo",
      archivedWorktree: "/gone",
      title: "my task",
    })
  })

  test("archived task WITHOUT the beta gate takes the normal live-engine path", async () => {
    state.archivedPreviewOn = false
    await ensureTaskSession(makeOrch() as unknown as OrchArg, makeTask({ archived: true }), "/repo", "claude")
    expect(state.ensureSessionCalls[0]).not.toMatchObject({ archived: true })
  })

  test("per-task preview mode opens the LIVE preview instead of the engine", async () => {
    state.archivedPreviewOn = true
    state.previewTasks = new Set(["t1"])
    const result = await ensureTaskSession(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude")
    expect(result).toBe(false)
    expect(state.ensureSessionCalls[0]).toMatchObject({ preview: true, cwd: "/wt", archivedWorktree: "/wt" })
  })
})

describe("enterTask", () => {
  test("cold path: builds, syncs zen, marks active, switches", async () => {
    const orch = makeOrch()
    await enterTask(orch as unknown as OrchArg, makeTask(), "/repo", "claude")
    expect(state.ensureSessionCalls).toHaveLength(1)
    expect(layoutZen.syncSessionZen).toHaveBeenCalledWith("kobe-t1")
    expect(orch.setActiveTask).toHaveBeenCalledWith("t1")
    expect(tmuxApplier.enterWindow).toHaveBeenCalledWith("kobe-t1")
  })

  test("captureFrom persists the FROM session's layout before leaving it", async () => {
    state.currentSession = "kobe-other"
    await enterTask(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude", { captureFrom: true })
    expect(tmuxApplier.captureGlobalLayout).toHaveBeenCalledWith("kobe-other")
  })

  test("captureFrom skips the capture when already on the target session", async () => {
    state.currentSession = "kobe-t1"
    state.existingSessions = new Set(["kobe-t1"])
    await enterTask(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude", { captureFrom: true })
    expect(tmuxApplier.captureGlobalLayout).not.toHaveBeenCalled()
  })

  test("heal: an existing session is re-ensured with the tag's cwd, not tasks.json's", async () => {
    state.existingSessions = new Set(["kobe-t1"])
    state.sessionOptions["@kobe_worktree"] = "/tag-wt"
    state.usableWorktrees.add("/tag-wt")
    await enterTask(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude", { heal: true })
    expect(state.ensureSessionCalls).toHaveLength(1)
    expect(state.ensureSessionCalls[0]).toMatchObject({ cwd: "/tag-wt" })
  })

  test("a heal failure never blocks the switch", async () => {
    state.existingSessions = new Set(["kobe-t1"])
    state.sessionOptions["@kobe_worktree"] = "/tag-wt"
    state.usableWorktrees.add("/tag-wt")
    vi.mocked(tmuxApplier.ensureSession).mockRejectedValueOnce(new Error("heal boom"))
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await enterTask(makeOrch() as unknown as OrchArg, makeTask(), "/repo", "claude", { heal: true })
    expect(tmuxApplier.enterWindow).toHaveBeenCalledWith("kobe-t1")
    errSpy.mockRestore()
  })

  test("a superseded enter skips setActiveTask + switch but keeps the build", async () => {
    const orch = makeOrch()
    await enterTask(orch as unknown as OrchArg, makeTask(), "/repo", "claude", { isCurrent: () => false })
    expect(state.ensureSessionCalls).toHaveLength(1) // build happened
    expect(orch.setActiveTask).not.toHaveBeenCalled()
    expect(tmuxApplier.enterWindow).not.toHaveBeenCalled()
  })

  test("a setActiveTask failure is swallowed and the switch still lands", async () => {
    const orch = makeOrch()
    orch.setActiveTask.mockRejectedValue(new Error("daemon gone"))
    await enterTask(orch as unknown as OrchArg, makeTask(), "/repo", "claude")
    expect(tmuxApplier.enterWindow).toHaveBeenCalledWith("kobe-t1")
  })
})

describe("jumpToTask", () => {
  test("delegates to enterTask with only the init-prompt intent", async () => {
    const orch = makeOrch()
    await jumpToTask(orch as unknown as Parameters<typeof jumpToTask>[0], makeTask(), "/repo", "claude", {
      includeInitPrompt: true,
    })
    expect(state.ensureSessionCalls[0]).toMatchObject({ launchInit: { initScript: "init.sh" } })
    expect(tmuxApplier.enterWindow).toHaveBeenCalledWith("kobe-t1")
  })
})
