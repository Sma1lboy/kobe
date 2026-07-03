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
  sessionExists: vi.fn(),
  switchClientBeforeKill: vi.fn(),
  killSession: vi.fn(),
  submitFeedback: vi.fn(),
  ensureSession: vi.fn(),
  resolveEngineLaunchInit: vi.fn(),
  waitForEnginePane: vi.fn(),
  pasteAndSubmit: vi.fn(),
  interactiveEngineCommand: vi.fn(),
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

vi.mock("../../src/tmux/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client.ts")>()
  return {
    ...actual,
    sessionExists: mocks.sessionExists,
    switchClientBeforeKill: mocks.switchClientBeforeKill,
    killSession: mocks.killSession,
  }
})

vi.mock("../../src/lib/feedback.ts", () => ({
  DEFAULT_FEEDBACK_CATEGORY_SLUG: "feedback",
  submitFeedback: mocks.submitFeedback,
}))

// The realPromptDeliveryOps seams: the session builder + repo-init are
// lazy-imported (so `kobe api list` never loads the TUI pane stack); the
// pane wait / paste and the engine command are static imports.
vi.mock("../../src/tui/panes/terminal/tmux.ts", () => ({ ensureSession: mocks.ensureSession }))
vi.mock("../../src/state/repo-init.ts", () => ({ resolveEngineLaunchInit: mocks.resolveEngineLaunchInit }))
vi.mock("../../src/tmux/prompt-delivery.ts", () => ({
  waitForEnginePane: mocks.waitForEnginePane,
  pasteAndSubmit: mocks.pasteAndSubmit,
}))
vi.mock("../../src/engine/interactive-command.ts", () => ({
  interactiveEngineCommand: mocks.interactiveEngineCommand,
}))

import { defaultApiRuntime, deliverPrompt, invokeVerb } from "../../src/cli/api-cmd.ts"
import type { DaemonRpc } from "../../src/cli/daemon-session.ts"
import { tmuxSessionName } from "../../src/tmux/client.ts"

beforeEach(() => {
  mocks.resolveMainRepoRoot.mockReset().mockResolvedValue("/repo/main")
  mocks.getPersistedString.mockReset().mockReturnValue(undefined)
  mocks.readWorktreeChanges.mockReset().mockResolvedValue({ added: 3, deleted: 1 })
  mocks.sessionExists.mockReset().mockResolvedValue(true)
  mocks.switchClientBeforeKill.mockReset().mockResolvedValue(undefined)
  mocks.killSession.mockReset().mockResolvedValue(undefined)
  mocks.submitFeedback.mockReset().mockReturnValue({ url: "https://github.com/d/1", number: 1 })
  mocks.ensureSession.mockReset().mockResolvedValue(true)
  mocks.resolveEngineLaunchInit.mockReset().mockResolvedValue({ initScript: "./setup.sh" })
  mocks.waitForEnginePane.mockReset().mockResolvedValue({ pane: "%7", ready: true })
  mocks.pasteAndSubmit.mockReset().mockResolvedValue(undefined)
  mocks.interactiveEngineCommand.mockReset().mockReturnValue(["claude", "--continue"])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("defaultApiRuntime", () => {
  it("isTaskRunning asks tmux for the task's canonical session name", async () => {
    await expect(defaultApiRuntime.isTaskRunning("t1")).resolves.toBe(true)
    expect(mocks.sessionExists).toHaveBeenCalledWith(tmuxSessionName("t1"))
  })

  it("resolveRepoRoot canonicalizes through state/repos resolveMainRepoRoot", async () => {
    await expect(defaultApiRuntime.resolveRepoRoot("/repo/main/.kobe/worktrees/x")).resolves.toBe("/repo/main")
    expect(mocks.resolveMainRepoRoot).toHaveBeenCalledWith("/repo/main/.kobe/worktrees/x")
  })

  it("defaultVendor reads lastSelectedVendor, treating blank/unset as undefined", async () => {
    mocks.getPersistedString.mockReturnValue("codex")
    await expect(defaultApiRuntime.defaultVendor()).resolves.toBe("codex")
    expect(mocks.getPersistedString).toHaveBeenCalledWith("lastSelectedVendor")

    mocks.getPersistedString.mockReturnValue("   ")
    await expect(defaultApiRuntime.defaultVendor()).resolves.toBeUndefined()

    mocks.getPersistedString.mockReturnValue(undefined)
    await expect(defaultApiRuntime.defaultVendor()).resolves.toBeUndefined()
  })

  it("readWorktreeChanges delegates to the sidebar's git reader", async () => {
    await expect(defaultApiRuntime.readWorktreeChanges("/wt/t1")).resolves.toEqual({ added: 3, deleted: 1 })
    expect(mocks.readWorktreeChanges).toHaveBeenCalledWith("/wt/t1")
  })

  it("tearDownSession switches any attached client away BEFORE killing the session", async () => {
    const order: string[] = []
    mocks.switchClientBeforeKill.mockImplementation(async () => {
      order.push("switch")
    })
    mocks.killSession.mockImplementation(async () => {
      order.push("kill")
    })
    await defaultApiRuntime.tearDownSession("t1")
    expect(mocks.switchClientBeforeKill).toHaveBeenCalledWith(tmuxSessionName("t1"))
    expect(mocks.killSession).toHaveBeenCalledWith(tmuxSessionName("t1"))
    expect(order).toEqual(["switch", "kill"])
  })

  it("tearDownSession swallows both failures — the RPC already committed", async () => {
    mocks.switchClientBeforeKill.mockRejectedValue(new Error("no client"))
    mocks.killSession.mockRejectedValue(new Error("no session"))
    await expect(defaultApiRuntime.tearDownSession("t1")).resolves.toBeUndefined()
    // The kill is still attempted even when the switch failed.
    expect(mocks.killSession).toHaveBeenCalledWith(tmuxSessionName("t1"))
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

  it("builds a fresh session through the lazily-imported builder, with repo-init + the engine command", async () => {
    mocks.sessionExists.mockResolvedValue(false)
    const result = await deliverPrompt(
      client,
      { id: "t1", worktreePath: "/wt/t1", vendor: "claude", repo: "/repo/x" },
      "go",
    )
    // repo-init resolved for the worktree (explicit prompt wins → intent none).
    expect(mocks.resolveEngineLaunchInit).toHaveBeenCalledWith("/repo/x", "/wt/t1", { kind: "none" })
    expect(mocks.interactiveEngineCommand).toHaveBeenCalledWith("claude")
    expect(mocks.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: tmuxSessionName("t1"),
        cwd: "/wt/t1",
        command: ["claude", "--continue"],
        launchInit: { initScript: "./setup.sh" },
      }),
    )
    expect(mocks.waitForEnginePane).toHaveBeenCalledWith(tmuxSessionName("t1"), true)
    expect(mocks.pasteAndSubmit).toHaveBeenCalledWith("%7", "go")
    expect(result).toEqual({ session: tmuxSessionName("t1"), pane: "%7", started: true, engineReady: true })
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
