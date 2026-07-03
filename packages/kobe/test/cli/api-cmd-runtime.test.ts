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

import { defaultApiRuntime, invokeVerb } from "../../src/cli/api-cmd.ts"
import { tmuxSessionName } from "../../src/tmux/client.ts"

beforeEach(() => {
  mocks.resolveMainRepoRoot.mockReset().mockResolvedValue("/repo/main")
  mocks.getPersistedString.mockReset().mockReturnValue(undefined)
  mocks.readWorktreeChanges.mockReset().mockResolvedValue({ added: 3, deleted: 1 })
  mocks.sessionExists.mockReset().mockResolvedValue(true)
  mocks.switchClientBeforeKill.mockReset().mockResolvedValue(undefined)
  mocks.killSession.mockReset().mockResolvedValue(undefined)
  mocks.submitFeedback.mockReset().mockReturnValue({ url: "https://github.com/d/1", number: 1 })
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
