/**
 * Unit tests for `src/tui/direct.ts` — the v0.6 direct-tmux entrypoint.
 *
 * `chooseInitialTask` is pure and was already covered. The rest of the file
 * (`startDirectTmux`) is the actual boot sequence: connect to the daemon,
 * pick/attach a tmux session, and fall back to the kobe-home session when
 * there are zero tasks. Every dependency is a module-level import (daemon
 * client, tmux helpers, engine command, state.json), so full coverage means
 * mocking each seam — done below, spreading nothing since we replace every
 * export each module needs (per the mocking gotcha: a stub that's missing an
 * export used by the code path becomes `undefined()` and a catch can eat it
 * silently).
 *
 * `Bun.spawn` (the actual tmux attach spawn) is a Bun-runtime global that
 * vitest's node-environment sandbox does not provide at all — confirmed by
 * `ReferenceError: Bun is not defined` when referencing it unset. We inject
 * a fake `globalThis.Bun.spawn` per test instead of `vi.spyOn`.
 */

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
vi.mock("../../src/tui/panes/terminal/layout-zen", () => ({
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

// ── startDirectTmux ─────────────────────────────────────────────────────────

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
    // Still reaches the fallback-session attach — boot isn't aborted.
    expect(mocks.ensureFallbackSession).toHaveBeenCalledTimes(1)
  })
})

describe("startDirectTmux — ensureRepos concurrency", () => {
  // A controllable `ensureMainTask` double: each call parks unresolved and is
  // settled by hand. `maxInFlight` records peak concurrency, so the serial loop
  // peaks at 1 while Promise.all peaks at N. `settleAll(failAt)` rejects the one
  // repo at `failAt` (error-isolation pin) and resolves the rest.
  function deferredEnsure() {
    const state = { pending: 0, maxInFlight: 0 } // `pending` == calls issued but not yet settled
    const settlers: Array<(err?: Error) => void> = []
    const fn = vi.fn((_repo: string) => {
      state.maxInFlight = Math.max(state.maxInFlight, ++state.pending)
      return new Promise((resolve, reject) => {
        settlers.push((err) => {
          state.pending--
          if (err) reject(err)
          else resolve(undefined)
        })
      })
    })
    const settleAll = (failAt?: number) =>
      settlers.forEach((s, i) => s(i === failAt ? new Error("git error") : undefined))
    return { fn, state, settleAll }
  }

  const flush = () => new Promise((r) => setTimeout(r, 0)) // drain the queue; every concurrent call has started

  test("all N saved repos are in flight before any response resolves (peak concurrency == N)", async () => {
    const repos = ["/repo/a", "/repo/b", "/repo/c", "/repo/d"]
    mocks.getSavedRepos.mockReturnValue(repos)
    const orch = makeOrch({ tasks: [] })
    const gate = deferredEnsure()
    orch.ensureMainTask = gate.fn
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    const done = startDirectTmux()
    await flush()
    // Concurrent shape: all four requests are in flight at once, none resolved.
    expect(gate.state.pending).toBe(repos.length)
    expect(gate.state.maxInFlight).toBe(repos.length)

    gate.settleAll()
    await done
    expect(gate.fn).toHaveBeenCalledTimes(repos.length)
    for (const repo of repos) expect(gate.fn).toHaveBeenCalledWith(repo)
  })

  test("a single repo peaks at 1 in flight (concurrency is a ceiling, not a floor)", async () => {
    mocks.getSavedRepos.mockReturnValue(["/only"])
    const orch = makeOrch({ tasks: [] })
    const gate = deferredEnsure()
    orch.ensureMainTask = gate.fn
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    const done = startDirectTmux()
    await flush()
    expect(gate.state.maxInFlight).toBe(1)
    gate.settleAll()
    await done
  })

  test("one failing repo still lets the others complete and boot proceeds", async () => {
    const repos = ["/repo/a", "/repo/bad", "/repo/c"]
    mocks.getSavedRepos.mockReturnValue(repos)
    const orch = makeOrch({ tasks: [] })
    const gate = deferredEnsure()
    orch.ensureMainTask = gate.fn
    mocks.RemoteOrchestrator.mockImplementation(() => orch)

    const done = startDirectTmux()
    await flush()
    expect(gate.state.maxInFlight).toBe(repos.length) // all issued concurrently
    gate.settleAll(1) // reject the middle repo, resolve the rest
    await done
    // The failure is logged, not thrown — Promise.all did not reject.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ensureMainTask failed for /repo/bad"),
      expect.any(Error),
    )
    // Boot still reached the fallback-session attach (no tasks path).
    expect(mocks.ensureFallbackSession).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBeUndefined()
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
