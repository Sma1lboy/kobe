import { describe, expect, it, vi } from "vitest"

const ensureHostedEngineMock = vi.hoisted(() =>
  vi.fn(async () => ({ alive: true })),
)
const hostedRpc = vi.hoisted(() => ({ request: vi.fn() }))
const closeHostedSessionMock = vi.hoisted(() => vi.fn())
const ensureHostedSessionHostMock = vi.hoisted(() =>
  vi.fn(async () => ({ rpc: hostedRpc, close: closeHostedSessionMock })),
)
const resolveEngineLaunchInitMock = vi.hoisted(() =>
  vi.fn((_repo: string, _worktree: string, intent: { kind: string }) => ({
    initScript: `init:${intent.kind}`,
    firstMessage:
      intent.kind === "repo-init"
        ? { source: "repo-init", text: "repo prompt" }
        : undefined,
  })),
)

vi.mock("../../kobe/src/engine/hosted-session.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../kobe/src/engine/hosted-session.ts")
  >()),
  ensureHostedEngine: ensureHostedEngineMock,
  ensureHostedSessionHost: ensureHostedSessionHostMock,
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
  it("lets canonical hosted sessions receive the repo init first prompt", async () => {
    ensureHostedEngineMock.mockClear()
    ensureHostedSessionHostMock.mockClear()
    closeHostedSessionMock.mockClear()
    resolveEngineLaunchInitMock.mockClear()

    await ensureTaskSessionAdapter(link(), "task-1")

    expect(resolveEngineLaunchInitMock).toHaveBeenCalledWith(
      "/repo/kobe",
      "/worktrees/story",
      { kind: "repo-init" },
    )
    expect(ensureHostedEngineMock).toHaveBeenCalledWith(
      hostedRpc,
      "/worktrees/story",
      expect.objectContaining({
        key: "task-1::tab-1",
        command: expect.arrayContaining([
          expect.stringContaining("repo prompt"),
        ]),
      }),
    )
    expect(closeHostedSessionMock).toHaveBeenCalledOnce()
  })

  it("keeps the repo init prompt inside the managed web PTY spawn spec", async () => {
    resolveEngineLaunchInitMock.mockClear()

    const spec = await engineSpecAdapter(link(), "task-2")

    expect(resolveEngineLaunchInitMock).toHaveBeenCalledWith(
      "/repo/kobe",
      "/worktrees/story",
      { kind: "repo-init" },
    )
    expect(spec.command.join(" ")).toContain("init:repo-init")
    expect(spec.command.join(" ")).toContain("repo prompt")
  })
})
