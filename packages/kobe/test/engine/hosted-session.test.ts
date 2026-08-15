import { describe, expect, it, vi } from "vitest"
import {
  type HostedSessionRpc,
  ensureHostedEngine,
  hostedTaskKeys,
  isHostedTaskKey,
  killHostedSessions,
  listHostedSessions,
  pastePromptWhenEngineUp,
} from "../../src/engine/hosted-session.ts"

function session(key: string) {
  return { key, alive: true, pid: 42, command: ["engine"], title: "engine" }
}

describe("hosted session helpers", () => {
  it("lists sessions and degrades an unreachable host to an empty inventory", async () => {
    const sessions = [session("task-a::tab-1")]
    const request = vi.fn().mockResolvedValueOnce({ sessions }).mockRejectedValueOnce(new Error("offline"))
    const rpc: HostedSessionRpc = { request }

    await expect(listHostedSessions(rpc)).resolves.toEqual(sessions)
    await expect(listHostedSessions(rpc)).resolves.toEqual([])
    expect(request).toHaveBeenNthCalledWith(1, "pty.list", {})
  })

  it("matches only exact task-id prefixes and selects every task session key", () => {
    const sessions = [session("task-a::tab-1"), session("task-a::shell-2"), session("task-ab::tab-1")]

    expect(isHostedTaskKey("task-a::tab-1", "task-a")).toBe(true)
    expect(isHostedTaskKey("task-ab::tab-1", "task-a")).toBe(false)
    expect(isHostedTaskKey("task-a", "task-a")).toBe(true)
    expect(hostedTaskKeys(sessions, "task-a")).toEqual(["task-a::tab-1", "task-a::shell-2"])
  })

  it("attempts every kill even when one hosted session has already disappeared", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("already gone")).mockResolvedValueOnce({})
    const rpc: HostedSessionRpc = { request }

    await expect(killHostedSessions(rpc, ["task-a::tab-1", "task-a::shell-2"])).resolves.toBeUndefined()
    expect(request.mock.calls).toEqual([
      ["pty.kill", { key: "task-a::tab-1" }],
      ["pty.kill", { key: "task-a::shell-2" }],
    ])
  })

  it("opens the canonical engine PTY, detaches the short-lived client, and returns the host result", async () => {
    const opened = { replay: "", alive: true, pid: 42, created: true }
    const request = vi.fn().mockResolvedValueOnce(opened).mockRejectedValueOnce(new Error("detached concurrently"))
    const rpc: HostedSessionRpc = { request }
    const launch = {
      key: "task-a::tab-1",
      command: ["engine", "--resume", "session-1"],
      env: {},
    }

    await expect(ensureHostedEngine(rpc, "/worktree", launch)).resolves.toEqual(opened)
    expect(request.mock.calls).toEqual([
      [
        "pty.open",
        {
          key: "task-a::tab-1",
          cwd: "/worktree",
          // No cols/rows: a size-less open must never resize a live
          // session away from its attached TUI (issue #18).
          command: ["engine", "--resume", "session-1"],
        },
      ],
      ["pty.detach", { key: "task-a::tab-1" }],
    ])
  })
})

describe("pastePromptWhenEngineUp (issue #25 first-message paste delivery)", () => {
  const noSleep = () => Promise.resolve()
  // ps -A -o pid=,ppid=,args= shape: a shell (pid 42) with a kimi child.
  const withEngine = "  42   1 /bin/zsh -ilc kimi\n  43  42 kimi\n"
  const shellOnly = "  42   1 /bin/zsh -ilc kimi\n"

  it("waits for the engine process, then bracketed-pastes and submits the prompt", async () => {
    const writes: unknown[] = []
    const request = vi.fn().mockImplementation((name: string, payload: unknown) => {
      if (name === "pty.list") return Promise.resolve({ sessions: [session("task-a::tab-1")] })
      if (name === "pty.write") {
        writes.push(payload)
        return Promise.resolve({})
      }
      return Promise.reject(new Error(`unexpected ${name}`))
    })
    const rpc: HostedSessionRpc = { request }

    const delivered = await pastePromptWhenEngineUp(rpc, "task-a::tab-1", "kimi", "fix it", {
      snapshot: async () => withEngine,
      sleep: noSleep,
    })

    expect(delivered).toBe(true)
    expect(writes).toEqual([
      { key: "task-a::tab-1", data: "\x1b[200~fix it\x1b[201~" },
      { key: "task-a::tab-1", data: "\r" },
    ])
  })

  it("returns false without pasting when the session dies before any engine appears", async () => {
    const request = vi.fn().mockResolvedValue({ sessions: [{ ...session("task-a::tab-1"), alive: false }] })
    const rpc: HostedSessionRpc = { request }

    const delivered = await pastePromptWhenEngineUp(rpc, "task-a::tab-1", "kimi", "fix it", {
      snapshot: async () => withEngine,
      sleep: noSleep,
    })

    expect(delivered).toBe(false)
    expect(request).not.toHaveBeenCalledWith("pty.write", expect.anything())
  })

  it("gives up within the wait budget when only a bare shell ever shows", async () => {
    const request = vi.fn().mockResolvedValue({ sessions: [session("task-a::tab-1")] })
    const rpc: HostedSessionRpc = { request }

    const delivered = await pastePromptWhenEngineUp(rpc, "task-a::tab-1", "kimi", "fix it", {
      timeoutMs: 5,
      snapshot: async () => shellOnly,
      sleep: noSleep,
    })

    expect(delivered).toBe(false)
    expect(request).not.toHaveBeenCalledWith("pty.write", expect.anything())
  })
})
