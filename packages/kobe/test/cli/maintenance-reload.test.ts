/**
 * `kobe reload` (`runReloadSubcommand`) — surgical Tasks/Ops pane respawn
 * across every live tmux session, without touching engine panes or
 * restarting the daemon. tmux + the dynamically-imported pane-heal module
 * are mocked so no real tmux/opentui graph is touched.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  tmuxAvailable: vi.fn(),
  tmuxArgs: vi.fn((..._args: string[]) => ["true"]),
  refreshKobeWorkspacePanes: vi.fn(),
  bunSpawn: vi.fn((_cmd: string[], _opts?: unknown) => ({
    stdout: new Response("").body,
    exited: Promise.resolve(0),
    kill: vi.fn(),
  })),
}))

vi.mock("../../src/tmux/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client.ts")>()
  return {
    ...actual,
    tmuxAvailable: mocks.tmuxAvailable,
    tmuxArgs: mocks.tmuxArgs,
  }
})

vi.mock("../../src/tui/panes/terminal/tmux.ts", () => ({
  refreshKobeWorkspacePanes: mocks.refreshKobeWorkspacePanes,
}))

import { runReloadSubcommand } from "../../src/cli/maintenance.ts"

let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof console.error>
let exitSpy: MockInstance<typeof process.exit>

beforeEach(() => {
  mocks.tmuxAvailable.mockReset().mockResolvedValue(true)
  mocks.tmuxArgs.mockReset().mockImplementation((..._args: string[]) => ["true"])
  mocks.refreshKobeWorkspacePanes.mockReset().mockResolvedValue(undefined)
  mocks.bunSpawn.mockReset().mockImplementation((_cmd: string[]) => ({
    stdout: new Response("").body,
    exited: Promise.resolve(0),
    kill: vi.fn(),
  }))
  vi.stubGlobal("Bun", { version: "0.0.0-test", spawn: mocks.bunSpawn })

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  logSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
  vi.unstubAllGlobals()
})

function output(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n")
}

describe("runReloadSubcommand", () => {
  it("--help prints usage without touching tmux", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runReloadSubcommand(["--help"])
    expect(writeSpy.mock.calls.join("")).toContain("Usage: kobe reload")
    expect(mocks.tmuxAvailable).not.toHaveBeenCalled()
  })

  it("rejects an unexpected argument with exit 2", async () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    await expect(runReloadSubcommand(["bogus"])).rejects.toThrow("exit 2")
    expect(errWrite.mock.calls.join("")).toContain('unexpected argument "bogus"')
  })

  it("reports no tmux when unavailable", async () => {
    mocks.tmuxAvailable.mockResolvedValue(false)
    await runReloadSubcommand([])
    expect(output()).toContain("tmux is not installed — no panes to reload")
    expect(mocks.refreshKobeWorkspacePanes).not.toHaveBeenCalled()
  })

  it("reports no sessions when list-sessions exits non-zero", async () => {
    mocks.bunSpawn.mockImplementation((_cmd: string[]) => ({
      stdout: new Response("").body,
      exited: Promise.resolve(1),
      kill: vi.fn(),
    }))
    await runReloadSubcommand([])
    expect(output()).toContain("no kobe tmux sessions")
  })

  it("reloads every listed session and reports the tally", async () => {
    mocks.bunSpawn.mockImplementation((_cmd: string[]) => ({
      stdout: new Response("sess-a\nsess-b\n").body,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    }))
    await runReloadSubcommand([])
    expect(mocks.refreshKobeWorkspacePanes).toHaveBeenCalledWith("sess-a")
    expect(mocks.refreshKobeWorkspacePanes).toHaveBeenCalledWith("sess-b")
    expect(output()).toContain("reloaded Tasks/Ops panes in 2/2 session(s)")
  })

  it("keeps going and reports a partial tally when one session's reload throws", async () => {
    mocks.bunSpawn.mockImplementation((_cmd: string[]) => ({
      stdout: new Response("sess-a\nsess-b\n").body,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    }))
    mocks.refreshKobeWorkspacePanes.mockImplementation(async (session: string) => {
      if (session === "sess-a") throw new Error("respawn failed")
    })
    await runReloadSubcommand([])
    expect(errSpy.mock.calls.join("\n")).toContain('failed to reload session "sess-a": respawn failed')
    expect(output()).toContain("reloaded Tasks/Ops panes in 1/2 session(s)")
  })
})
