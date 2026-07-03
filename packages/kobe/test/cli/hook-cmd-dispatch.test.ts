/**
 * `kobe hook <verb>` dispatcher (`runHookSubcommand` + `ensureGlobalKobeHooks`)
 * — sibling of hook-cmd.test.ts (which covers the pure parsers). The daemon
 * client is mocked (hooks are non-spawning by contract) and the engine hook
 * adapters are faked so no real ~/.claude/settings.json is ever written.
 * Because every failure path in the dispatcher is deliberately swallowed,
 * each test asserts the positive effect (the exact RPC + args), never just
 * "didn't throw".
 */

import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  connectIfRunning: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  adapter: {
    supportsHooks: vi.fn(() => true),
    supportsWorktreeSync: vi.fn(() => true),
    activityDetailFromPayload: vi.fn(() => undefined as unknown),
    globalSettingsPath: vi.fn(() => "/fake/.claude/settings.json"),
    installActivityHooks: vi.fn(),
    installWorktreeWatchHook: vi.fn(),
    removeWorktreeSyncHook: vi.fn(),
  },
}))

vi.mock("@sma1lboy/kobe-daemon/client/daemon-process", () => ({
  connectIfRunning: mocks.connectIfRunning,
}))

vi.mock("../../src/engine/hook-adapter.ts", () => ({
  createEngineHookAdapter: vi.fn(() => mocks.adapter),
}))

import { runHookSubcommand } from "../../src/cli/hook-cmd.ts"
import { getPersistedString } from "../../src/state/repos.ts"

let home: string
let originalHome: string | undefined

function stubStdin(payload: unknown): void {
  vi.stubGlobal("Bun", { stdin: { text: () => Promise.resolve(JSON.stringify(payload)) } })
}

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-hook-"))
  process.env.KOBE_HOME_DIR = home

  mocks.connectIfRunning.mockReset().mockResolvedValue({ request: mocks.request, close: mocks.close })
  mocks.request.mockReset().mockResolvedValue({})
  mocks.close.mockReset()
  mocks.adapter.supportsHooks.mockClear().mockReturnValue(true)
  mocks.adapter.supportsWorktreeSync.mockClear().mockReturnValue(true)
  mocks.adapter.activityDetailFromPayload.mockClear().mockReturnValue(undefined)
  mocks.adapter.globalSettingsPath.mockClear().mockReturnValue("/fake/.claude/settings.json")
  mocks.adapter.installActivityHooks.mockClear()
  mocks.adapter.installWorktreeWatchHook.mockClear()
  mocks.adapter.removeWorktreeSyncHook.mockClear()
  stubStdin({})
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe("runHookSubcommand — activity verbs", () => {
  it("drops an unknown verb without dialing the daemon", async () => {
    await runHookSubcommand(["not-a-kind"])
    expect(mocks.connectIfRunning).not.toHaveBeenCalled()
  })

  it("reports the payload cwd for a known verb and closes the socket", async () => {
    stubStdin({ cwd: "/some/task/worktree" })
    await runHookSubcommand(["turn-complete"])
    expect(mocks.request).toHaveBeenCalledWith("engine.reportEvent", {
      cwd: "/some/task/worktree",
      kind: "turn-complete",
    })
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  it("honours --task-id over the cwd mapping", async () => {
    stubStdin({ cwd: "/ignored" })
    await runHookSubcommand(["turn-start", "--task-id", "t1"])
    expect(mocks.request).toHaveBeenCalledWith("engine.reportEvent", { taskId: "t1", kind: "turn-start" })
  })

  it("attaches the adapter's normalized detail when one is produced", async () => {
    mocks.adapter.activityDetailFromPayload.mockReturnValue({ failureClass: "rate-limit" })
    await runHookSubcommand(["turn-failed"])
    expect(mocks.request).toHaveBeenCalledWith(
      "engine.reportEvent",
      expect.objectContaining({ kind: "turn-failed", detail: { failureClass: "rate-limit" } }),
    )
  })

  it("drops the event silently when no daemon is running (never spawns one)", async () => {
    mocks.connectIfRunning.mockResolvedValue(null)
    await runHookSubcommand(["turn-complete"])
    expect(mocks.request).not.toHaveBeenCalled()
  })
})

describe("runHookSubcommand worktree-created", () => {
  it("asks the daemon to reconcile the path of a `git worktree add`", async () => {
    stubStdin({ cwd: "/repo", tool_input: { command: "git worktree add -b feat .claude/worktrees/lynx main" } })
    await runHookSubcommand(["worktree-created"])
    expect(mocks.request).toHaveBeenCalledWith("worktree.reconcile", {
      cwd: "/repo",
      worktreePath: resolve("/repo", ".claude/worktrees/lynx"),
    })
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })

  it("asks the daemon to archive the task of a `git worktree remove`", async () => {
    stubStdin({ cwd: "/repo", tool_input: { command: "git worktree remove -f ../wt" } })
    await runHookSubcommand(["worktree-created"])
    expect(mocks.request).toHaveBeenCalledWith("worktree.archiveRemoved", {
      worktreePath: resolve("/repo", "../wt"),
    })
  })

  it("no-ops fast on a Bash command that isn't a worktree add/remove", async () => {
    stubStdin({ cwd: "/repo", tool_input: { command: "git status && ls" } })
    await runHookSubcommand(["worktree-created"])
    expect(mocks.connectIfRunning).not.toHaveBeenCalled()
  })
})

describe("kobe hook setup (deprecated cleanup)", () => {
  it("removes the old WorktreeCreate hook from the global settings and persists sync=off", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runHookSubcommand(["setup"])
    expect(mocks.adapter.removeWorktreeSyncHook).toHaveBeenCalledWith(join(homedir(), ".claude", "settings.json"))
    expect(getPersistedString("externalWorktreeSync")).toBe("off")
    expect(outSpy.mock.calls.join("")).toContain("deprecated")
    outSpy.mockRestore()
  })
})
