import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  ensureSession: vi.fn(async () => true),
  sessionExists: vi.fn(async () => false),
  resolveLaunch: vi.fn((_repo: string, _worktree: string, intent: { kind: string }) => ({
    initScript: `init:${intent.kind}`,
    firstMessage: intent.kind === "repo-init" ? { source: "repo-init", text: "repo prompt" } : undefined,
  })),
  killSession: vi.fn(async () => {}),
  switchClientBeforeKill: vi.fn(async () => {}),
}))

vi.mock("../../src/tui/panes/terminal/tmux.ts", () => ({
  ensureSession: mocks.ensureSession,
  sessionExists: mocks.sessionExists,
  tmuxSessionName: (taskId: string) => `kobe-${taskId}`,
}))
vi.mock("../../src/tmux/client.ts", () => ({
  killSession: mocks.killSession,
  switchClientBeforeKill: mocks.switchClientBeforeKill,
}))
vi.mock("../../src/state/repo-init.ts", () => ({ resolveEngineLaunchInit: mocks.resolveLaunch }))

import {
  engineSpecAdapter,
  ensureTaskSessionAdapter,
  tearDownTaskSessionAdapter,
  terminalSpecAdapter,
} from "../../src/core/daemon-session-adapter.ts"

function link(): DaemonRpcClient {
  return {
    request: vi.fn(async <T>(name: string, payload?: unknown): Promise<T> => {
      if (name === "task.get") {
        return {
          task: {
            id: (payload as { taskId: string }).taskId,
            repo: "/repo/kobe",
            kind: "task",
            vendor: "claude",
            worktreePath: "",
          },
        } as T
      }
      if (name === "task.ensureWorktree") return { worktreePath: "/worktrees/story" } as T
      return {} as T
    }),
  } as unknown as DaemonRpcClient
}

describe("daemon session adapter", () => {
  beforeEach(() => vi.clearAllMocks())

  it("materializes the worktree and creates the canonical tmux session", async () => {
    await expect(ensureTaskSessionAdapter(link(), "task-1")).resolves.toEqual({
      session: "kobe-task-1",
      worktreePath: "/worktrees/story",
    })
    expect(mocks.resolveLaunch).toHaveBeenCalledWith("/repo/kobe", "/worktrees/story", { kind: "repo-init" })
    expect(mocks.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: "kobe-task-1", cwd: "/worktrees/story" }),
    )
  })

  it("builds engine and terminal specs without duplicating the first prompt", async () => {
    const engine = await engineSpecAdapter(link(), "task-2")
    expect(engine.cwd).toBe("/worktrees/story")
    expect(engine.command.join(" ")).toContain("init:none")
    await expect(terminalSpecAdapter(link(), "task-2")).resolves.toEqual({
      cwd: "/worktrees/story",
      command: [process.env.SHELL?.trim() || "/bin/zsh", "-il"],
    })
  })

  it("tears down a task session best-effort", async () => {
    await tearDownTaskSessionAdapter("task-3")
    expect(mocks.switchClientBeforeKill).toHaveBeenCalledWith("kobe-task-3")
    expect(mocks.killSession).toHaveBeenCalledWith("kobe-task-3")
  })

  it("reuses materialized worktrees and rejects a failed materialization", async () => {
    mocks.sessionExists.mockResolvedValueOnce(true)
    const existing = {
      request: vi.fn(
        async <T>() =>
          ({
            task: { id: "task-4", repo: "/repo/kobe", vendor: "claude", worktreePath: "/existing" },
          }) as T,
      ),
    } as unknown as DaemonRpcClient
    await expect(ensureTaskSessionAdapter(existing, "task-4")).resolves.toEqual({
      session: "kobe-task-4",
      worktreePath: "/existing",
    })
    expect(mocks.ensureSession).not.toHaveBeenCalled()

    const missing = {
      request: vi.fn(
        async <T>(name: string) =>
          (name === "task.get"
            ? { task: { id: "task-5", repo: "/repo/kobe", vendor: "claude", worktreePath: "" } }
            : { worktreePath: null }) as T,
      ),
    } as unknown as DaemonRpcClient
    await expect(terminalSpecAdapter(missing, "task-5")).rejects.toThrow("has no worktree")
  })
})
