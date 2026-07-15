import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  ensureHost: vi.fn(),
  openHost: vi.fn(),
  ensureEngine: vi.fn(async () => ({ alive: true, created: true })),
  listSessions: vi.fn(async () => [{ key: "task-3::tab-1", alive: true }]),
  taskKeys: vi.fn(() => ["task-3::tab-1"]),
  killSessions: vi.fn(async () => {}),
  buildLaunch: vi.fn((input: { task: { id: string } }) => ({
    key: `${input.task.id}::tab-1`,
    command: ["/bin/zsh", "-ilc", "claude 'repo prompt'"],
  })),
}))

vi.mock("../../src/engine/hosted-session.ts", () => ({
  ensureHostedSessionHost: mocks.ensureHost,
  openHostedSessionHost: mocks.openHost,
  ensureHostedEngine: mocks.ensureEngine,
  listHostedSessions: mocks.listSessions,
  hostedTaskKeys: mocks.taskKeys,
  killHostedSessions: mocks.killSessions,
}))
vi.mock("../../src/engine/session-launch.ts", () => ({ buildEngineSessionLaunch: mocks.buildLaunch }))

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
  beforeEach(() => {
    vi.clearAllMocks()
    const host = { rpc: { request: vi.fn() }, close: mocks.close }
    mocks.ensureHost.mockResolvedValue(host)
    mocks.openHost.mockResolvedValue(host)
  })

  it("materializes the worktree and creates the canonical hosted session", async () => {
    await expect(ensureTaskSessionAdapter(link(), "task-1")).resolves.toEqual({
      session: "task-1::tab-1",
      worktreePath: "/worktrees/story",
    })
    expect(mocks.buildLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ id: "task-1", kind: "task", vendor: "claude" }),
        worktreePath: "/worktrees/story",
        promptIntent: { kind: "repo-init" },
      }),
    )
    expect(mocks.ensureEngine).toHaveBeenCalledWith(expect.anything(), "/worktrees/story", expect.anything())
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it("builds engine and terminal specs without duplicating the first prompt", async () => {
    const engine = await engineSpecAdapter(link(), "task-2")
    expect(engine.cwd).toBe("/worktrees/story")
    expect(engine.command).toEqual(["/bin/zsh", "-ilc", "claude 'repo prompt'"])
    await expect(terminalSpecAdapter(link(), "task-2")).resolves.toEqual({
      cwd: "/worktrees/story",
      command: [process.env.SHELL?.trim() || "/bin/zsh", "-il"],
    })
  })

  it("tears down a task session best-effort", async () => {
    await tearDownTaskSessionAdapter("task-3")
    expect(mocks.killSessions).toHaveBeenCalledWith(expect.anything(), ["task-3::tab-1"])
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it("reuses materialized worktrees and rejects a failed materialization", async () => {
    const existing = {
      request: vi.fn(
        async <T>() =>
          ({
            task: { id: "task-4", repo: "/repo/kobe", vendor: "claude", worktreePath: "/existing" },
          }) as T,
      ),
    } as unknown as DaemonRpcClient
    await expect(ensureTaskSessionAdapter(existing, "task-4")).resolves.toEqual({
      session: "task-4::tab-1",
      worktreePath: "/existing",
    })
    expect(mocks.ensureEngine).toHaveBeenCalledOnce()

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

  it("refuses engine and terminal specs for a task being deleted", async () => {
    const deleting = {
      request: vi.fn(
        async <T>() =>
          ({
            task: {
              id: "task-6",
              repo: "/repo/kobe",
              vendor: "claude",
              worktreePath: "/worktrees/task-6",
              deletion: { phase: "running", force: false, requestedAt: "2026-07-15T00:00:00.000Z" },
            },
          }) as T,
      ),
    } as unknown as DaemonRpcClient

    await expect(engineSpecAdapter(deleting, "task-6")).rejects.toThrow("TASK_DELETING")
    await expect(terminalSpecAdapter(deleting, "task-6")).rejects.toThrow("TASK_DELETING")
    expect(mocks.ensureEngine).not.toHaveBeenCalled()
  })
})
