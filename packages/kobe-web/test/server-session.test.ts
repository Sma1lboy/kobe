import { describe, expect, it, vi } from "vitest"

const ensureSessionMock = vi.hoisted(() => vi.fn(async () => true))
const sessionExistsMock = vi.hoisted(() => vi.fn(async () => false))
const resolveEngineLaunchInitMock = vi.hoisted(() =>
  vi.fn((_repo: string, _worktree: string, intent: { kind: string }) => ({
    initScript: `init:${intent.kind}`,
    firstMessage:
      intent.kind === "repo-init"
        ? { source: "repo-init", text: "repo prompt" }
        : undefined,
  })),
)

vi.mock("../../kobe/src/tui/panes/terminal/tmux.ts", () => ({
  ensureSession: ensureSessionMock,
  sessionExists: sessionExistsMock,
  tmuxSessionName: (taskId: string) => `kobe-${taskId}`,
}))

vi.mock("../../kobe/src/tmux/client.ts", () => ({
  killSession: vi.fn(),
  switchClientBeforeKill: vi.fn(),
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
  it("lets canonical tmux sessions receive the repo init first prompt", async () => {
    ensureSessionMock.mockClear()
    resolveEngineLaunchInitMock.mockClear()
    sessionExistsMock.mockResolvedValueOnce(false)

    await ensureTaskSessionAdapter(link(), "task-1")

    expect(resolveEngineLaunchInitMock).toHaveBeenCalledWith(
      "/repo/kobe",
      "/worktrees/story",
      { kind: "repo-init" },
    )
    expect(ensureSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "kobe-task-1",
        cwd: "/worktrees/story",
        launchInit: {
          initScript: "init:repo-init",
          firstMessage: { source: "repo-init", text: "repo prompt" },
        },
      }),
    )
  })

  it("keeps web PTY engine specs from duplicating the repo init prompt", async () => {
    resolveEngineLaunchInitMock.mockClear()

    const spec = await engineSpecAdapter(link(), "task-2")

    expect(resolveEngineLaunchInitMock).toHaveBeenCalledWith(
      "/repo/kobe",
      "/worktrees/story",
      { kind: "none" },
    )
    expect(spec.command.join(" ")).toContain("init:none")
  })
})
