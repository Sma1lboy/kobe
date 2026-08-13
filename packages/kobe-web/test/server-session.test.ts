import { describe, expect, it, vi } from "vitest"

const hostedSession = vi.hoisted(() => ({
  close: vi.fn(),
  ensureEngine: vi.fn(async () => ({ alive: true, created: true })),
  rpc: { request: vi.fn() },
}))
const resolveEngineLaunchInitMock = vi.hoisted(() =>
  vi.fn((_repo: string, _worktree: string, intent: { kind: string }) => ({
    initScript: `init:${intent.kind}`,
    firstMessage:
      intent.kind === "repo-init"
        ? { source: "repo-init", text: "repo prompt" }
        : undefined,
  })),
)

vi.mock("../../kobe/src/engine/hosted-session.ts", () => ({
  deliverToHostedKey: vi.fn(),
  ensureHostedEngine: hostedSession.ensureEngine,
  ensureHostedSessionHost: vi.fn(async () => ({
    rpc: hostedSession.rpc,
    close: hostedSession.close,
  })),
  findHostedEngineKey: vi.fn(),
  hostedTaskKeys: vi.fn(),
  killHostedSessions: vi.fn(),
  listHostedSessions: vi.fn(),
  openHostedSessionHost: vi.fn(),
}))

vi.mock("../../kobe/src/state/repo-init.ts", () => ({
  resolveEngineLaunchInit: resolveEngineLaunchInitMock,
}))

import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import { engineSpecAdapter, ensureTaskSessionAdapter } from "../../kobe/src/core/daemon-session-adapter.ts"

function link(): DaemonRpcClient {
  return {
    async request(name, payload) {
      if (name === "task.get") {
        return {
          task: {
            id: (payload as { taskId: string }).taskId,
            repo: "/repo/kobe",
            vendor: "claude",
            worktreePath: "",
          },
        }
      }
      if (name === "task.ensureWorktree") return { worktreePath: "/worktrees/story" }
      return {}
    },
  }
}

describe("web session launch init", () => {
  it("lets hosted engine sessions receive the repo init first prompt", async () => {
    hostedSession.close.mockClear()
    hostedSession.ensureEngine.mockClear()
    resolveEngineLaunchInitMock.mockClear()

    await ensureTaskSessionAdapter(link(), "task-1")

    expect(resolveEngineLaunchInitMock).toHaveBeenCalledWith(
      "/repo/kobe",
      "/worktrees/story",
      { kind: "repo-init" },
      "task-1",
    )
    expect(hostedSession.ensureEngine).toHaveBeenCalledWith(
      hostedSession.rpc,
      "/worktrees/story",
      expect.objectContaining({
        key: "task-1::tab-1",
        command: expect.arrayContaining([expect.stringContaining("init:repo-init")]),
      }),
    )
  })

  it("keeps web PTY engine specs from duplicating the repo init prompt", async () => {
    resolveEngineLaunchInitMock.mockClear()

    const spec = await engineSpecAdapter(link(), "task-2")

    expect(resolveEngineLaunchInitMock).toHaveBeenCalledWith(
      "/repo/kobe",
      "/worktrees/story",
      { kind: "repo-init" },
      "task-2",
    )
    expect(spec.command.join(" ")).toContain("init:repo-init")
  })
})
