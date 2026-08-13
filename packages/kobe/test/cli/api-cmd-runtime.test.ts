/**
 * `defaultApiRuntime` — the real side-effect seam `kobe api` handlers run
 * against in production. Each operation lazily imports (or statically uses)
 * a heavier module; those modules are mocked here so what's asserted is the
 * DELEGATION contract: which underlying function each runtime op calls,
 * with what arguments, and the swallow-semantics of tearDownSession (a
 * teardown failure must never fail the already-committed RPC). Plus the
 * offline `feedback` verb, whose GitHub call is a mocked seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveMainRepoRoot: vi.fn(),
  getPersistedString: vi.fn(),
  readWorktreeChanges: vi.fn(),
  submitFeedback: vi.fn(),
  interactiveEngineCommand: vi.fn(),
  ensurePtyHost: vi.fn(),
  deliverHostedPrompt: vi.fn(),
  closePtyHost: vi.fn(),
  buildEngineSessionLaunch: vi.fn(),
  openPtyHost: vi.fn(),
  listSessions: vi.fn(),
  findEngineKey: vi.fn(),
  taskKeys: vi.fn(),
  killTaskSessions: vi.fn(),
  readTabsSnapshot: vi.fn(),
  publishCliTabSnapshot: vi.fn(),
}))

vi.mock("../../src/state/repos.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/repos.ts")>()
  return {
    ...actual,
    resolveMainRepoRoot: mocks.resolveMainRepoRoot,
    getPersistedString: mocks.getPersistedString,
  }
})

vi.mock("../../src/tui/panes/sidebar/worktree-changes.ts", () => ({
  readWorktreeChanges: mocks.readWorktreeChanges,
}))

vi.mock("../../src/lib/feedback.ts", () => ({
  DEFAULT_FEEDBACK_CATEGORY_SLUG: "feedback",
  submitFeedback: mocks.submitFeedback,
}))

vi.mock("../../src/engine/interactive-command.ts", () => ({
  interactiveEngineCommand: mocks.interactiveEngineCommand,
}))

vi.mock("../../src/engine/session-launch.ts", () => ({
  buildEngineSessionLaunch: mocks.buildEngineSessionLaunch,
}))

// Real join/liveness logic, mocked STATE READ: unit tests must never touch
// the developer's actual ~/.config/rove/state.json (also silences the
// publishCliTabSnapshot write deliverPrompt would otherwise attempt).
vi.mock("../../src/cli/api/tab-snapshot.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/api/tab-snapshot.ts")>()
  return {
    ...actual,
    readTabsSnapshot: mocks.readTabsSnapshot,
    publishCliTabSnapshot: mocks.publishCliTabSnapshot,
  }
})

vi.mock("../../src/cli/api/pty-delivery.ts", () => ({
  openPtyHost: mocks.openPtyHost,
  ensurePtyHost: mocks.ensurePtyHost,
  deliverHostedPrompt: mocks.deliverHostedPrompt,
  listSessions: mocks.listSessions,
  findEngineKey: mocks.findEngineKey,
  taskKeys: mocks.taskKeys,
  killTaskSessions: mocks.killTaskSessions,
  deliverToKey: vi.fn(async () => false),
}))

import { defaultApiRuntime, deliverPrompt, invokeVerb } from "../../src/cli/api-cmd.ts"
import type { DaemonRpc } from "../../src/cli/daemon-session.ts"

beforeEach(() => {
  mocks.resolveMainRepoRoot.mockReset().mockResolvedValue("/repo/main")
  mocks.getPersistedString.mockReset().mockReturnValue(undefined)
  mocks.readWorktreeChanges.mockReset().mockResolvedValue({ added: 3, deleted: 1 })
  mocks.submitFeedback.mockReset().mockReturnValue({ url: "https://github.com/d/1", number: 1 })
  mocks.interactiveEngineCommand.mockReset().mockReturnValue(["claude", "--continue"])
  mocks.closePtyHost.mockReset()
  mocks.ensurePtyHost.mockReset().mockResolvedValue({ rpc: { request: vi.fn() }, close: mocks.closePtyHost })
  mocks.buildEngineSessionLaunch.mockReset().mockReturnValue({
    key: "t1::tab-1",
    command: ["/bin/zsh", "-ilc", "claude --continue 'go'"],
  })
  mocks.deliverHostedPrompt.mockReset().mockResolvedValue({
    session: "t1::tab-1",
    pane: "t1::tab-1",
    started: true,
    engineReady: true,
    delivered: true,
  })
  mocks.openPtyHost.mockReset().mockResolvedValue({ rpc: { request: vi.fn() }, close: mocks.closePtyHost })
  mocks.listSessions.mockReset().mockResolvedValue([{ key: "t1::tab-1", alive: true }])
  mocks.findEngineKey.mockReset().mockReturnValue("t1::tab-1")
  mocks.taskKeys.mockReset().mockReturnValue(["t1::tab-1", "t1::tab-2"])
  mocks.killTaskSessions.mockReset().mockResolvedValue(undefined)
  mocks.readTabsSnapshot.mockReset().mockReturnValue(undefined)
  mocks.publishCliTabSnapshot.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe("defaultApiRuntime", () => {
  it("isTaskRunning is true on a live canonical tab-1 even without a snapshot", async () => {
    await expect(defaultApiRuntime.isTaskRunning("t1")).resolves.toBe(true)
  })

  it("isTaskRunning is true when only a LATER engine tab is alive (issue #5)", async () => {
    mocks.listSessions.mockResolvedValue([
      { key: "t1::tab-1", alive: false },
      { key: "t1::tab-2", alive: true },
    ])
    mocks.readTabsSnapshot.mockReturnValue({
      tabs: [{ kind: "engine", id: "tab-2", title: null, ordinal: 2 }],
      activeId: "tab-2",
      nextOrdinal: 3,
    })
    await expect(defaultApiRuntime.isTaskRunning("t1")).resolves.toBe(true)
  })

  it("isTaskRunning is false when only a non-engine tab is alive", async () => {
    mocks.listSessions.mockResolvedValue([{ key: "t1::tab-2", alive: true }])
    mocks.readTabsSnapshot.mockReturnValue({
      tabs: [{ kind: "command", id: "tab-2", title: "editor", ordinal: 2, command: ["nvim"] }],
      activeId: "tab-2",
      nextOrdinal: 3,
    })
    await expect(defaultApiRuntime.isTaskRunning("t1")).resolves.toBe(false)
  })

  it("isTaskRunning is false when no PTY Host is running", async () => {
    mocks.openPtyHost.mockResolvedValueOnce(null)
    await expect(defaultApiRuntime.isTaskRunning("t1")).resolves.toBe(false)
  })

  it("taskTabs joins the persisted snapshot with per-tab session liveness", async () => {
    mocks.listSessions.mockResolvedValue([
      { key: "t1::tab-1", alive: false },
      { key: "t1::tab-2", alive: true },
    ])
    mocks.readTabsSnapshot.mockReturnValue({
      tabs: [
        { kind: "engine", id: "tab-1", title: null, ordinal: 1, lastTitle: "boot" },
        { kind: "engine", id: "tab-2", title: null, ordinal: 2, liveVendor: "claude" },
      ],
      activeId: "tab-2",
      nextOrdinal: 3,
    })
    const { tabs, running } = await defaultApiRuntime.taskTabs("t1")
    expect(running).toBe(true)
    expect(tabs).toEqual([
      {
        id: "tab-1",
        kind: "engine",
        title: null,
        vendor: null,
        liveVendor: null,
        lastTitle: "boot",
        autoTitle: null,
        alive: false,
        exit: null,
      },
      {
        id: "tab-2",
        kind: "engine",
        title: null,
        vendor: null,
        liveVendor: "claude",
        lastTitle: null,
        autoTitle: null,
        alive: true,
        exit: null,
      },
    ])
  })

  it("resolveRepoRoot canonicalizes through state/repos resolveMainRepoRoot", async () => {
    await expect(defaultApiRuntime.resolveRepoRoot("/repo/main/.kobe/worktrees/x")).resolves.toBe("/repo/main")
    expect(mocks.resolveMainRepoRoot).toHaveBeenCalledWith("/repo/main/.kobe/worktrees/x")
  })

  it("defaultVendor resolves repo last-active → global default, blank/unset → undefined", async () => {
    mocks.getPersistedString.mockReturnValue("codex")
    await expect(defaultApiRuntime.defaultVendor()).resolves.toBe("codex")
    expect(mocks.getPersistedString).toHaveBeenCalledWith("defaultVendor")

    mocks.getPersistedString.mockClear()
    mocks.getPersistedString.mockReturnValue("codex")
    await expect(defaultApiRuntime.defaultVendor("/repo")).resolves.toBe("codex")
    expect(mocks.getPersistedString).toHaveBeenCalledWith("lastActiveVendor./repo")

    mocks.getPersistedString.mockReturnValue("   ")
    await expect(defaultApiRuntime.defaultVendor()).resolves.toBeUndefined()

    mocks.getPersistedString.mockReturnValue(undefined)
    await expect(defaultApiRuntime.defaultVendor()).resolves.toBeUndefined()
  })

  it("readWorktreeChanges delegates to the sidebar's git reader", async () => {
    await expect(defaultApiRuntime.readWorktreeChanges("/wt/t1")).resolves.toEqual({ added: 3, deleted: 1 })
    expect(mocks.readWorktreeChanges).toHaveBeenCalledWith("/wt/t1")
  })

  it("tearDownSession kills every hosted task key and closes the probe client", async () => {
    await defaultApiRuntime.tearDownSession("t1")
    expect(mocks.taskKeys).toHaveBeenCalledWith(expect.any(Array), "t1")
    expect(mocks.killTaskSessions).toHaveBeenCalledWith(expect.anything(), ["t1::tab-1", "t1::tab-2"])
    expect(mocks.closePtyHost).toHaveBeenCalledOnce()
  })

  it("tearDownSession swallows PTY failures — the RPC already committed", async () => {
    mocks.killTaskSessions.mockRejectedValue(new Error("host closed"))
    await expect(defaultApiRuntime.tearDownSession("t1")).resolves.toBeUndefined()
  })
})

describe("realPromptDeliveryOps (deliverPrompt with the default ops)", () => {
  const client: DaemonRpc = {
    request: async () => {
      throw new Error("no RPC expected — the target already has a worktree")
    },
    subscribe: async () => ({}),
    onChannel: () => () => {},
  }

  it("builds and starts a fresh hosted session through the shared launch spec", async () => {
    const result = await deliverPrompt(
      client,
      {
        id: "t1",
        kind: "task",
        worktreePath: "/wt/t1",
        vendor: "claude",
        modelEffort: "high",
        repo: "/repo/x",
      },
      "go",
    )
    expect(mocks.ensurePtyHost).toHaveBeenCalledOnce()
    expect(mocks.interactiveEngineCommand).toHaveBeenCalledWith("claude", "high")
    expect(mocks.buildEngineSessionLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: { id: "t1", kind: "task", vendor: "claude", repo: "/repo/x" },
        worktreePath: "/wt/t1",
        argv: ["claude", "--continue"],
        promptIntent: { kind: "explicit", prompt: "go" },
      }),
    )
    expect(mocks.deliverHostedPrompt).toHaveBeenCalledWith(
      expect.anything(),
      { id: "t1", engineBin: "claude" },
      "/wt/t1",
      "go",
      expect.objectContaining({ key: "t1::tab-1" }),
      { forceNew: false },
    )
    expect(mocks.closePtyHost).toHaveBeenCalledOnce()
    expect(result).toEqual({
      session: "t1::tab-1",
      pane: "t1::tab-1",
      started: true,
      engineReady: true,
      delivered: true,
    })
  })

  it("launches a newTask target as the new-task intent (branch-rename coda)", async () => {
    // add / fan-out mark their first delivery with newTask — the launch spec
    // then rides the "new-task" intent so the coda is appended (issue #8).
    vi.stubEnv("KOBE_TASK_ID", "")
    await deliverPrompt(
      client,
      { id: "t1", kind: "task", worktreePath: "/wt/t1", vendor: "claude", repo: "/repo/x", newTask: true },
      "go",
    )
    expect(mocks.buildEngineSessionLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ promptIntent: { kind: "new-task", prompt: "go", spawnerTaskId: undefined } }),
    )
  })

  it("threads the CLI process's own $KOBE_TASK_ID as the new task's spawner", async () => {
    // An `add` run from inside another task's engine tab carries that task's
    // id; the coda then tells the new agent where to `send` its outcome.
    vi.stubEnv("KOBE_TASK_ID", "spawner-1")
    await deliverPrompt(
      client,
      { id: "t1", kind: "task", worktreePath: "/wt/t1", vendor: "claude", repo: "/repo/x", newTask: true },
      "go",
    )
    expect(mocks.buildEngineSessionLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ promptIntent: { kind: "new-task", prompt: "go", spawnerTaskId: "spawner-1" } }),
    )
  })

  it("maps PTY RPC failures to SESSION_FAILED and always closes the client", async () => {
    mocks.deliverHostedPrompt.mockRejectedValue(new Error("socket closed"))

    await expect(
      deliverPrompt(client, { id: "t1", worktreePath: "/wt/t1", vendor: "claude" }, "go"),
    ).rejects.toMatchObject({ code: "SESSION_FAILED" })
    expect(mocks.closePtyHost).toHaveBeenCalledOnce()
  })
})

describe("feedback verb", () => {
  it("submits title/body through the gh seam and wraps the discussion result", async () => {
    const result = await invokeVerb("feedback", ["--title", "Love it", "--body", "Details"], { client: null })
    expect(mocks.submitFeedback).toHaveBeenCalledWith({
      title: "Love it",
      body: "Details",
      categorySlug: undefined,
    })
    expect(result).toEqual({ ok: true, discussion: { url: "https://github.com/d/1", number: 1 } })
  })

  it("passes an explicit --category slug through", async () => {
    await invokeVerb("feedback", ["--title", "T", "--body", "B", "--category", "ideas"], { client: null })
    expect(mocks.submitFeedback).toHaveBeenCalledWith({ title: "T", body: "B", categorySlug: "ideas" })
  })
})
