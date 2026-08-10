/**
 * `pty-delivery.ts` — the hosted-backend engine-key resolver and bracketed
 * paste that `kobe api` delivery routes through. The load-bearing bit is
 * `findEngineKey`: it MUST resolve the engine tab (never a shell tab) and
 * MUST return null when a task has no engine — that null is what stops
 * delivery from double-opening a second engine in the same worktree.
 */

import type { PtySessionInfo } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import { describe, expect, it } from "vitest"
import {
  deliverHostedPrompt,
  deliverToExactTab,
  deliverToKey,
  findEngineKey,
  isTaskKey,
  taskKeys,
} from "../../src/cli/api/pty-delivery.ts"
import { ApiError } from "../../src/cli/api/types.ts"

function session(key: string, command: string[], alive = true): PtySessionInfo {
  return { key, alive, pid: alive ? 123 : null, command, title: "" }
}

/** A ps snapshot in which pid 123 (the session shell) hosts `child`. */
function psWith(child: string): () => Promise<string> {
  return async () => `123 1 -zsh\n456 123 ${child}\n`
}

describe("findEngineKey", () => {
  it("① picks the deterministic <taskId>::tab-1 engine", () => {
    const sessions = [session("t1::tab-1", ["claude"])]
    expect(findEngineKey(sessions, "t1", "claude")).toBe("t1::tab-1")
  })

  it("② with tab-1 engine + tab-2 shell, picks tab-1 (never the shell)", () => {
    const sessions = [session("t1::tab-1", ["claude"]), session("t1::tab-2", ["/bin/zsh"])]
    expect(findEngineKey(sessions, "t1", "claude")).toBe("t1::tab-1")
  })

  it("③ no engine tab → null (caller must NOT double-open)", () => {
    // Only a shell tab, and tab-1 absent: there is no engine to deliver into.
    const sessions = [session("t1::tab-2", ["/bin/zsh"])]
    expect(findEngineKey(sessions, "t1", "claude")).toBeNull()
  })

  it("falls back to an argv match when tab-1 is renumbered/absent", () => {
    // No tab-1, but a session whose command is the vendor's engine binary.
    const sessions = [session("t1::tab-5", ["codex"]), session("t1::tab-2", ["/bin/bash"])]
    expect(findEngineKey(sessions, "t1", "codex")).toBe("t1::tab-5")
  })

  it("skips a DEAD tab-1 (an exited engine cannot receive a prompt)", () => {
    const sessions = [session("t1::tab-1", ["claude"], false)]
    expect(findEngineKey(sessions, "t1", "claude")).toBeNull()
  })

  it("ignores other tasks' sessions", () => {
    const sessions = [session("t2::tab-1", ["claude"])]
    expect(findEngineKey(sessions, "t1", "claude")).toBeNull()
  })

  it("without engineBin, still resolves tab-1 (liveness/teardown path)", () => {
    const sessions = [session("t1::tab-1", ["claude"])]
    expect(findEngineKey(sessions, "t1")).toBe("t1::tab-1")
  })
})

describe("isTaskKey / taskKeys", () => {
  it("matches the segment before the first ::", () => {
    expect(isTaskKey("t1::tab-1", "t1")).toBe(true)
    expect(isTaskKey("t1", "t1")).toBe(true)
    expect(isTaskKey("t10::tab-1", "t1")).toBe(false)
  })

  it("taskKeys returns every key for the task (alive or not — teardown)", () => {
    const sessions = [
      session("t1::tab-1", ["claude"]),
      session("t1::tab-2", ["/bin/zsh"], false),
      session("t2::tab-1", ["claude"]),
    ]
    expect(taskKeys(sessions, "t1")).toEqual(["t1::tab-1", "t1::tab-2"])
  })
})

describe("deliverToKey", () => {
  function recorder() {
    const calls: Array<{ name: string; payload: unknown }> = []
    const rpc = {
      request: async <T>(name: string, payload?: unknown): Promise<T> => {
        calls.push({ name, payload })
        if (name === "pty.open") return { replay: "", alive: true } as T
        return {} as T
      },
    }
    return { rpc, calls }
  }

  it("reattaches then writes bracketed prompt + deferred CR", async () => {
    const { rpc, calls } = recorder()
    const ok = await deliverToKey(rpc, "t1::tab-1", "/wt/t1", "do the thing")
    expect(ok).toBe(true)
    expect(calls.map((c) => c.name)).toEqual(["pty.open", "pty.write", "pty.write"])
    expect(calls[0].payload).toMatchObject({ key: "t1::tab-1", cwd: "/wt/t1" })
    // Bracketed paste markers wrap the prompt; the CR is a SEPARATE write.
    expect(calls[1].payload).toEqual({ key: "t1::tab-1", data: "\x1b[200~do the thing\x1b[201~" })
    expect(calls[2].payload).toEqual({ key: "t1::tab-1", data: "\r" })
  })

  it("returns false without writing when the session is dead", async () => {
    const calls: Array<{ name: string }> = []
    const rpc = {
      request: async <T>(name: string): Promise<T> => {
        calls.push({ name })
        if (name === "pty.open") return { replay: "", alive: false } as T
        return {} as T
      },
    }
    expect(await deliverToKey(rpc, "t1::tab-1", "/wt/t1", "x")).toBe(false)
    expect(calls.map((c) => c.name)).toEqual(["pty.open"]) // no write into a dead pty
  })
})

describe("deliverHostedPrompt", () => {
  it("starts the canonical engine session with the explicit prompt already in its launch argv", async () => {
    const calls: Array<{ name: string; payload: unknown }> = []
    const rpc = {
      request: async <T>(name: string, payload?: unknown): Promise<T> => {
        calls.push({ name, payload })
        if (name === "pty.list") return { sessions: [] } as T
        if (name === "pty.open") return { replay: "", alive: true, created: true } as T
        return {} as T
      },
    }

    const result = await deliverHostedPrompt(rpc, { id: "t1", engineBin: "claude" }, "/wt/t1", "fix it", {
      key: "t1::tab-1",
      command: ["/bin/zsh", "-ilc", "claude 'fix it'"],
    })

    expect(calls.map((call) => call.name)).toEqual(["pty.list", "pty.open", "pty.detach"])
    expect(calls[1].payload).toMatchObject({
      key: "t1::tab-1",
      cwd: "/wt/t1",
      command: ["/bin/zsh", "-ilc", "claude 'fix it'"],
    })
    expect(result).toEqual({
      session: "t1::tab-1",
      pane: "t1::tab-1",
      started: true,
      engineReady: true,
      delivered: true,
    })
  })

  it("delivers once when another caller wins the create race", async () => {
    const calls: Array<{ name: string; payload: unknown }> = []
    const rpc = {
      request: async <T>(name: string, payload?: unknown): Promise<T> => {
        calls.push({ name, payload })
        if (name === "pty.list") return { sessions: [] } as T
        if (name === "pty.open") return { replay: "", alive: true, created: false } as T
        return {} as T
      },
    }

    const result = await deliverHostedPrompt(rpc, { id: "t1", engineBin: "claude" }, "/wt/t1", "fix it", {
      key: "t1::tab-1",
      command: ["/bin/zsh", "-ilc", "claude 'fix it'"],
    })

    expect(calls.map((call) => call.name)).toEqual(["pty.list", "pty.open", "pty.write", "pty.write", "pty.detach"])
    expect(result).toMatchObject({ started: false, delivered: true })
  })

  it("delivers into an existing engine when the foreground gate sees the engine process", async () => {
    const calls: string[] = []
    const rpc = {
      request: async <T>(name: string): Promise<T> => {
        calls.push(name)
        if (name === "pty.list") return { sessions: [session("t1::tab-1", ["claude"])] } as T
        if (name === "pty.open") return { replay: "", alive: true } as T
        return {} as T
      },
    }
    const result = await deliverHostedPrompt(
      rpc,
      { id: "t1", engineBin: "claude" },
      "/wt/t1",
      "go",
      { key: "t1::tab-1", command: ["claude"] },
      { snapshot: psWith("claude") },
    )
    expect(result).toMatchObject({ started: false, delivered: true })
    expect(calls).toContain("pty.write")
  })

  it("REFUSES an existing session whose engine exited into the keepAlive shell", async () => {
    const rpc = {
      request: async <T>(name: string): Promise<T> => {
        if (name === "pty.list") return { sessions: [session("t1::tab-1", ["claude"])] } as T
        throw new Error(`unexpected rpc ${name}`)
      },
    }
    const err = await deliverHostedPrompt(
      rpc,
      { id: "t1", engineBin: "claude" },
      "/wt/t1",
      "go",
      { key: "t1::tab-1", command: ["claude"] },
      { snapshot: psWith("/bin/sh") }, // keepAlive fallback: shell only
    ).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe("ENGINE_NOT_RUNNING")
  })
})

describe("deliverToExactTab", () => {
  function rpcWith(sessions: PtySessionInfo[]) {
    const calls: string[] = []
    const rpc = {
      request: async <T>(name: string): Promise<T> => {
        calls.push(name)
        if (name === "pty.list") return { sessions } as T
        if (name === "pty.open") return { replay: "", alive: true } as T
        return {} as T
      },
    }
    return { rpc, calls }
  }

  it("a DIFFERENT vendor's engine in the addressed tab still receives (cross-vendor send)", async () => {
    const { rpc, calls } = rpcWith([session("t1::tab-2", ["codex"])])
    const result = await deliverToExactTab(rpc, "t1", "tab-2", "/wt/t1", "go", {
      engineBin: "claude", // task vendor is claude; tab runs codex
      snapshot: psWith("codex"),
    })
    expect(result).toMatchObject({ session: "t1::tab-2", delivered: true })
    expect(calls).toContain("pty.write")
  })

  it("refuses a tab that is a plain shell (ENGINE_NOT_RUNNING, not a paste)", async () => {
    const { rpc, calls } = rpcWith([session("t1::tab-2", ["/bin/zsh"])])
    const err = await deliverToExactTab(rpc, "t1", "tab-2", "/wt/t1", "go", {
      snapshot: psWith("grep something"),
    }).then(
      () => null,
      (e) => e,
    )
    expect((err as ApiError).code).toBe("ENGINE_NOT_RUNNING")
    expect(calls).not.toContain("pty.write")
  })

  it("refuses a dead/absent tab (TAB_NOT_FOUND)", async () => {
    const { rpc } = rpcWith([session("t1::tab-2", ["claude"], false)])
    const err = await deliverToExactTab(rpc, "t1", "tab-2", "/wt/t1", "go").then(
      () => null,
      (e) => e,
    )
    expect((err as ApiError).code).toBe("TAB_NOT_FOUND")
  })
})
