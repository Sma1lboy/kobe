import { beforeEach, describe, expect, test, vi } from "vitest"
import { PLACEHOLDER_TASK_TITLE } from "../../src/orchestrator/core"
import { type Task, toTaskId } from "../../src/types/task"

const mocks = vi.hoisted(() => ({
  setClientLogContext: vi.fn(),
  connectOrStartDaemon: vi.fn(),
  RemoteOrchestrator: vi.fn(),
  interactiveEngineCommand: vi.fn(() => ["engine", "--flag"]),
  deriveTitleFromSession: vi.fn(async () => ""),
  resolveEngineLaunchInit: vi.fn(() => undefined),
  addSavedRepo: vi.fn((p: string) => ({ added: true, path: p, total: 1 })),
  getCustomEngineIds: vi.fn(() => [] as string[]),
  getPersistedString: vi.fn((_key: string) => undefined as string | undefined),
  getSavedRepos: vi.fn(() => ["/repo"] as readonly string[]),
  normalizeSavedRepos: vi.fn(),
  setPersistedString: vi.fn(),
  ensureFallbackSession: vi.fn(async () => "kobe-home"),
  applyTmuxChromeTheme: vi.fn(async () => {}),
  syncSessionZen: vi.fn(async () => {}),
  attachArgv: vi.fn((name: string) => ["tmux", "attach-session", "-t", `=${name}`]),
  ensureSession: vi.fn(async () => true),
  observeSessionVendor: vi.fn(async () => null as string | null),
  prepareWindowForAttach: vi.fn(async () => {}),
  sessionExists: vi.fn(async () => true),
  tmuxAvailable: vi.fn(async () => true),
  tmuxSessionName: vi.fn((id: string) => `kobe-${id}`),
  ensureGlobalKobeHooks: vi.fn(async () => {}),
}))

vi.mock("@sma1lboy/kobe-daemon/client/client-log", () => ({
  setClientLogContext: mocks.setClientLogContext,
}))
vi.mock("@sma1lboy/kobe-daemon/client/daemon-process", () => ({
  connectOrStartDaemon: mocks.connectOrStartDaemon,
}))
vi.mock("../../src/client/remote-orchestrator", () => ({
  RemoteOrchestrator: mocks.RemoteOrchestrator,
}))
vi.mock("../../src/engine/interactive-command", () => ({
  interactiveEngineCommand: mocks.interactiveEngineCommand,
}))
vi.mock("../../src/monitor/auto-title", () => ({
  deriveTitleFromSession: mocks.deriveTitleFromSession,
}))
vi.mock("../../src/state/repo-init", () => ({
  resolveEngineLaunchInit: mocks.resolveEngineLaunchInit,
}))
vi.mock("../../src/state/repos", () => ({
  addSavedRepo: mocks.addSavedRepo,
  getCustomEngineIds: mocks.getCustomEngineIds,
  getPersistedString: mocks.getPersistedString,
  getSavedRepos: mocks.getSavedRepos,
  normalizeSavedRepos: mocks.normalizeSavedRepos,
  setPersistedString: mocks.setPersistedString,
}))
vi.mock("../../src/tmux/client", () => ({
  ensureFallbackSession: mocks.ensureFallbackSession,
}))
vi.mock("../../src/tui/lib/tmux-border-theme", () => ({
  applyTmuxChromeTheme: mocks.applyTmuxChromeTheme,
}))
vi.mock("../../src/tui/panes/terminal/layout-actions", () => ({
  syncSessionZen: mocks.syncSessionZen,
}))
vi.mock("../../src/tui/panes/terminal/tmux", () => ({
  attachArgv: mocks.attachArgv,
  ensureSession: mocks.ensureSession,
  observeSessionVendor: mocks.observeSessionVendor,
  prepareWindowForAttach: mocks.prepareWindowForAttach,
  sessionExists: mocks.sessionExists,
  tmuxAvailable: mocks.tmuxAvailable,
  tmuxSessionName: mocks.tmuxSessionName,
}))
vi.mock("../../src/cli/hook-cmd", () => ({
  ensureGlobalKobeHooks: mocks.ensureGlobalKobeHooks,
}))

import { type InitialTaskChoice, chooseInitialTask, startDirectTmux } from "../../src/tui/direct"

function task(overrides: Partial<Omit<Task, "id">> & { id: string }): Task {
  return {
    id: toTaskId(overrides.id),
    title: overrides.title ?? overrides.id,
    repo: overrides.repo ?? "/repo",
    branch: overrides.branch ?? "main",
    worktreePath: overrides.worktreePath ?? "/repo",
    kind: overrides.kind ?? "task",
    status: overrides.status ?? "backlog",
    archived: overrides.archived ?? false,
    pinned: overrides.pinned ?? false,
    vendor: overrides.vendor ?? "claude",
    prStatus: overrides.prStatus,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  }
}

describe("chooseInitialTask", () => {
  test("prefers the active task, then the persisted task", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })]
    expect(chooseInitialTask(tasks, { activeTaskId: "b", persistedTaskId: "c" })?.id).toBe("b")
    expect(chooseInitialTask(tasks, { persistedTaskId: "c" })?.id).toBe("c")
  })

  test("falls back to cwd main task, pinned visible task, then first visible task", () => {
    const tasks = [
      task({ id: "archived", archived: true }),
      task({ id: "main", kind: "main", repo: "/cwd" }),
      task({ id: "pinned", pinned: true }),
      task({ id: "visible" }),
    ]
    expect(chooseInitialTask(tasks, { cwdRepo: "/cwd" })?.id).toBe("main")
    expect(chooseInitialTask(tasks)?.id).toBe("pinned")
    expect(chooseInitialTask([task({ id: "archived", archived: true }), task({ id: "visible" })])?.id).toBe("visible")
  })

  test("empty task list yields undefined", () => {
    const choice: InitialTaskChoice = {}
    expect(chooseInitialTask([], choice)).toBeUndefined()
  })
})

type FakeOrch = {
  init: ReturnType<typeof vi.fn>
  listTasks: ReturnType<typeof vi.fn>
  activeTaskSignal: ReturnType<typeof vi.fn>
  ensureMainTask: ReturnType<typeof vi.fn>
  ensureWorktree: ReturnType<typeof vi.fn>
  setActiveTask: ReturnType<typeof vi.fn>
  setVendor: ReturnType<typeof vi.fn>
  getTask: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

function makeOrch(opts: { tasks?: readonly Task[]; activeTaskId?: string | null; afterTask?: Task } = {}): FakeOrch {
  return {
    init: vi.fn(async () => {}),
    listTasks: vi.fn(() => opts.tasks ?? []),
    activeTaskSignal: vi.fn(() => () => opts.activeTaskId ?? null),
    ensureMainTask: vi.fn(async () => {}),
    ensureWorktree: vi.fn(async () => "/resolved/wt"),
    setActiveTask: vi.fn(async () => {}),
    setVendor: vi.fn(async () => {}),
    getTask: vi.fn(() => opts.afterTask),
    setTitle: vi.fn(async () => {}),
    dispose: vi.fn(),
  }
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  process.exitCode = undefined
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  mocks.tmuxAvailable.mockResolvedValue(true)
  mocks.connectOrStartDaemon.mockResolvedValue({ socketPath: "/tmp/kobe.sock" })
  mocks.ensureSession.mockResolvedValue(true)
  mocks.sessionExists.mockResolvedValue(true)
  mocks.attachArgv.mockImplementation((name: string) => ["tmux", "attach-session", "-t", `=${name}`])
  mocks.tmuxSessionName.mockImplementation((id: string) => `kobe-${id}`)
  mocks.getSavedRepos.mockReturnValue(["/repo"])
  mocks.getPersistedString.mockReturnValue(undefined)
  ;(globalThis as { Bun?: unknown }).Bun = { spawn: vi.fn(() => ({ exited: Promise.resolve(0) })) }
})

describe("startDirectTmux — tmux unavailable", () => {
  test("errors and sets exitCode without touching the daemon", async () => {
    mocks.tmuxAvailable.mockResolvedValue(false)

    await startDirectTmux()

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("tmux not found"))
    expect(process.exitCode).toBe(1)
    expect(mocks.connectOrStartDaemon).not.toHaveBeenCalled()
  })
})

describe("startDirectTmux — no tasks (fallback session)", () => {
  test("attaches the kobe-home fallback session on a clean success", async () => {
    const orch = makeOrch({ tasks: [] })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    await startDirectTmux()

    expect(mocks.ensureFallbackSession).toHaveBeenCalledTimes(1)
    expect(mocks.applyTmuxChromeTheme).toHaveBeenCalledTimes(1)
    expect(mocks.syncSessionZen).toHaveBeenCalledWith("kobe-home")
    expect(mocks.prepareWindowForAttach).toHaveBeenCalledWith("kobe-home")
    expect(mocks.attachArgv).toHaveBeenCalledWith("kobe-home")
    expect(process.exitCode).toBeUndefined()
    expect(orch.dispose).toHaveBeenCalledTimes(1)
  })

  test("a failed attach (spawn throws) errors and sets exitCode", async () => {
    const orch = makeOrch({ tasks: [] })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    ;(globalThis as { Bun?: unknown }).Bun = {
      spawn: vi.fn(() => {
        throw new Error("spawn ENOENT")
      }),
    }

    await startDirectTmux()

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to attach to the kobe-home session"))
    expect(process.exitCode).toBe(1)
  })
})

describe("startDirectTmux — ensureRepos", () => {
  test("saves the cwd as a repo when no repos are saved yet", async () => {
    mocks.getSavedRepos.mockReturnValue([])
    const orch = makeOrch({ tasks: [] })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    await startDirectTmux()

    expect(mocks.addSavedRepo).toHaveBeenCalledWith(process.cwd())
    expect(orch.ensureMainTask).toHaveBeenCalledWith(process.cwd())
  })

  test("ensureMainTask failures are swallowed (logged) so boot still proceeds", async () => {
    const orch = makeOrch({ tasks: [] })
    orch.ensureMainTask.mockRejectedValueOnce(new Error("git error"))
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    await startDirectTmux()

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("ensureMainTask failed"), expect.any(Error))
    expect(mocks.ensureFallbackSession).toHaveBeenCalledTimes(1)
  })
})

describe("startDirectTmux — task chosen, full attach flow", () => {
  function chosenTask(over: Partial<Omit<Task, "id">> = {}): Task {
    return task({ id: "t1", worktreePath: "/wt/t1", vendor: "claude", ...over })
  }

  test("happy path: ensureSession, attach, clean exit, no auto-title (title isn't the placeholder)", async () => {
    const t = chosenTask({ title: "Real title" })
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id, afterTask: t })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    await startDirectTmux()

    expect(orch.setActiveTask).toHaveBeenCalledWith(t.id)
    expect(mocks.setPersistedString).toHaveBeenCalledWith("lastSelectedTaskId", t.id)
    expect(mocks.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: "kobe-t1", cwd: "/wt/t1", taskId: t.id, vendor: "claude", repo: "/repo" }),
    )
    expect(mocks.applyTmuxChromeTheme).toHaveBeenCalledTimes(1)
    expect(mocks.syncSessionZen).toHaveBeenCalledWith("kobe-t1")
    expect(mocks.prepareWindowForAttach).toHaveBeenCalledWith("kobe-t1")
    expect(mocks.deriveTitleFromSession).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  test("placeholder-titled task after attach triggers auto-title derivation", async () => {
    const t = chosenTask({ title: PLACEHOLDER_TASK_TITLE })
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id, afterTask: t })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    mocks.deriveTitleFromSession.mockResolvedValue("Derived Title")

    await startDirectTmux()

    expect(mocks.deriveTitleFromSession).toHaveBeenCalledWith("/wt/t1", "claude")
    expect(orch.setTitle).toHaveBeenCalledWith(t.id, "Derived Title")
  })

  test("auto-title derivation failure is logged, not fatal", async () => {
    const t = chosenTask({ title: PLACEHOLDER_TASK_TITLE })
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id, afterTask: t })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    mocks.deriveTitleFromSession.mockRejectedValue(new Error("no session"))

    await startDirectTmux()

    expect(consoleErrorSpy).toHaveBeenCalledWith("[kobe] auto-title failed:", expect.any(Error))
    expect(orch.setTitle).not.toHaveBeenCalled()
  })

  test("ensureSession failure errors, sets exitCode, and never attaches", async () => {
    const t = chosenTask()
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    mocks.ensureSession.mockResolvedValue(false)
    const spawnSpy = vi.fn()
    ;(globalThis as { Bun?: unknown }).Bun = { spawn: spawnSpy }

    await startDirectTmux()

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to start"))
    expect(process.exitCode).toBe(1)
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  test("attach spawn failure (Bun.spawn throws) errors and sets exitCode", async () => {
    const t = chosenTask()
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    ;(globalThis as { Bun?: unknown }).Bun = {
      spawn: vi.fn(() => {
        throw new Error("spawn ENOENT")
      }),
    }

    await startDirectTmux()

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to attach to tmux session kobe-t1"))
    expect(process.exitCode).toBe(1)
  })

  test("non-zero attach exit + session gone: reports 'ended unexpectedly' with that exit code", async () => {
    const t = chosenTask()
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    mocks.sessionExists.mockResolvedValue(false)
    ;(globalThis as { Bun?: unknown }).Bun = { spawn: vi.fn(() => ({ exited: Promise.resolve(137) })) }

    await startDirectTmux()

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("ended unexpectedly"))
    expect(process.exitCode).toBe(137)
  })

  test("non-zero attach exit but the session still exists: not an error, proceeds to auto-title check", async () => {
    const t = chosenTask({ title: PLACEHOLDER_TASK_TITLE })
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id, afterTask: t })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    mocks.sessionExists.mockResolvedValue(true)
    mocks.deriveTitleFromSession.mockResolvedValue("Title")
    ;(globalThis as { Bun?: unknown }).Bun = { spawn: vi.fn(() => ({ exited: Promise.resolve(1) })) }

    await startDirectTmux()

    expect(consoleErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining("ended unexpectedly"))
    expect(process.exitCode).toBeUndefined()
    expect(orch.setTitle).toHaveBeenCalledWith(t.id, "Title")
  })

  test("cwd falls back to ensureWorktree when the task has no worktreePath yet", async () => {
    const t = chosenTask({ worktreePath: "" })
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    await startDirectTmux()

    expect(orch.ensureWorktree).toHaveBeenCalledWith(t.id)
    expect(mocks.ensureSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/resolved/wt" }))
  })
})

describe("startDirectTmux — main-task vendor reconciliation", () => {
  test("adopts the LIVE session vendor over the persisted default when one is running", async () => {
    const t = task({ id: "m1", kind: "main", worktreePath: "/repo", vendor: "claude" })
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    mocks.observeSessionVendor.mockResolvedValue("codex")

    await startDirectTmux()

    expect(orch.setVendor).toHaveBeenCalledWith(t.id, "codex")
    expect(mocks.ensureSession).toHaveBeenCalledWith(expect.objectContaining({ vendor: "codex" }))
  })

  test("falls back to the persisted global default when no session is live", async () => {
    const t = task({ id: "m1", kind: "main", worktreePath: "/repo", vendor: "claude" })
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)
    mocks.observeSessionVendor.mockResolvedValue(null)
    mocks.getPersistedString.mockImplementation((key: string) => (key === "lastSelectedVendor" ? "codex" : undefined))

    await startDirectTmux()

    expect(orch.setVendor).toHaveBeenCalledWith(t.id, "codex")
  })

  test("a non-main task's vendor is never reconciled against the live session", async () => {
    const t = chosenTaskRegular()
    const orch = makeOrch({ tasks: [t], activeTaskId: t.id })
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    await startDirectTmux()

    expect(mocks.observeSessionVendor).not.toHaveBeenCalled()
    expect(orch.setVendor).not.toHaveBeenCalled()
  })

  function chosenTaskRegular(): Task {
    return task({ id: "t1", worktreePath: "/wt/t1", vendor: "claude" })
  }
})
