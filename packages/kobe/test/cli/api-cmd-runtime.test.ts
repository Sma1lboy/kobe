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
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("defaultApiRuntime", () => {
  it("isTaskRunning resolves only the canonical hosted engine key", async () => {
    await expect(defaultApiRuntime.isTaskRunning("t1")).resolves.toBe(true)
    expect(mocks.findEngineKey).toHaveBeenCalledWith(expect.any(Array), "t1")
  })

  it("isTaskRunning is false when no PTY Host is running", async () => {
    mocks.openPtyHost.mockResolvedValueOnce(null)
    await expect(defaultApiRuntime.isTaskRunning("t1")).resolves.toBe(false)
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
