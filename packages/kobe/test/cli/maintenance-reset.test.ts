/**
 * `kobe reset` (`runResetSubcommand`) — daemon + tmux teardown, with an
 * optional `--hard` wipe of tasks.json/state.json. Never touches git
 * worktrees. Daemon lifecycle + tmux are mocked (real ones would actually
 * kill processes / shell out); state lives under a per-test KOBE_HOME_DIR
 * tempdir so the `--hard` file-deletion behavior is observed for real.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  stopDaemonProcess: vi.fn(),
  tmuxAvailable: vi.fn(),
  tmuxArgs: vi.fn((..._args: string[]) => ["true"]),
  termAllPaneGroups: vi.fn(),
  bunSpawn: vi.fn((_cmd: string[], _opts?: unknown) => ({
    stdout: new Response("").body,
    exited: Promise.resolve(0),
    kill: vi.fn(),
  })),
  /** What the mocked y/N confirm prompt answers on a TTY. */
  confirmAnswer: "y",
}))

// confirmTty goes through readline against the real stdin; answer it
// synchronously so a TTY test never blocks.
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: (_q: string, cb: (answer: string) => void) => cb(mocks.confirmAnswer),
    close: vi.fn(),
  })),
}))

vi.mock("@sma1lboy/kobe-daemon/daemon/lifecycle", () => ({
  stopDaemonProcess: mocks.stopDaemonProcess,
}))

vi.mock("../../src/tmux/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client.ts")>()
  return {
    ...actual,
    KOBE_TMUX_SOCKET: "kobe-test",
    tmuxAvailable: mocks.tmuxAvailable,
    tmuxArgs: mocks.tmuxArgs,
    termAllPaneGroups: mocks.termAllPaneGroups,
  }
})

import { runResetSubcommand } from "../../src/cli/maintenance.ts"

let home: string
let originalHome: string | undefined
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>
let originalIsTTY: boolean | undefined

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-reset-"))
  process.env.KOBE_HOME_DIR = home
  mkdirSync(join(home, ".kobe"), { recursive: true })

  mocks.confirmAnswer = "y"
  mocks.stopDaemonProcess.mockReset().mockResolvedValue({ pid: null, method: "absent" })
  mocks.tmuxAvailable.mockReset().mockResolvedValue(false)
  mocks.tmuxArgs.mockReset().mockImplementation((..._args: string[]) => ["true"])
  mocks.termAllPaneGroups.mockReset()
  mocks.bunSpawn.mockReset().mockImplementation((_cmd: string[]) => ({
    stdout: new Response("").body,
    exited: Promise.resolve(0),
    kill: vi.fn(),
  }))
  vi.stubGlobal("Bun", { version: "0.0.0-test", spawn: mocks.bunSpawn })

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
  // Default: non-TTY stdin so the confirmation prompt would hang forever if
  // reached without --yes — every test below passes --yes unless it's
  // specifically exercising the non-interactive "no prompt possible" path.
  originalIsTTY = process.stdin.isTTY
  process.stdin.isTTY = false
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  ;(process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = originalIsTTY
  rmSync(home, { recursive: true, force: true })
  logSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
  vi.unstubAllGlobals()
})

function output(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n")
}

describe("runResetSubcommand", () => {
  it("--help says reset replaces the standalone pty host without touching it", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runResetSubcommand(["--help"])
    const help = writeSpy.mock.calls.join("")
    expect(help).toContain("Usage: kobe reset")
    expect(help).toContain("stop the standalone pty host")
    expect(help).toContain("next launch starts a fresh host")
    expect(mocks.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("rejects an unknown flag with usage + exit 2", async () => {
    await expect(runResetSubcommand(["--harf"])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain('unknown argument "--harf"')
  })

  it("on a non-TTY without --yes, prints the plan and does not act", async () => {
    await runResetSubcommand([])
    expect(output()).toContain("re-run with --yes to proceed")
    expect(mocks.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("--yes stops the daemon and reports tmux not installed when unavailable", async () => {
    mocks.stopDaemonProcess.mockResolvedValue({ pid: 123, method: "sigterm" })
    await runResetSubcommand(["--yes"])
    const out = output()
    expect(out).toContain("daemon: stopped via sigterm (pid 123)")
    expect(out).toContain("tmux: not installed")
    expect(out).toContain("reset complete")
    expect(mocks.stopDaemonProcess).toHaveBeenCalledWith(expect.any(String), expect.any(String))
  })

  it("reports 'was not running' when stopDaemonProcess method is absent", async () => {
    mocks.stopDaemonProcess.mockResolvedValue({ pid: null, method: "absent" })
    await runResetSubcommand(["-y"])
    expect(output()).toContain("daemon: was not running")
  })

  it("kills the tmux server when tmux is available", async () => {
    mocks.tmuxAvailable.mockResolvedValue(true)
    mocks.bunSpawn.mockImplementation((_cmd: string[]) => ({
      stdout: new Response("").body,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    }))
    await runResetSubcommand(["--yes"])
    expect(mocks.termAllPaneGroups).toHaveBeenCalledTimes(1)
    expect(output()).toContain("tmux: killed all sessions on `kobe-test`")
  })

  it("reports no sessions when kill-server exits non-zero", async () => {
    mocks.tmuxAvailable.mockResolvedValue(true)
    mocks.bunSpawn.mockImplementation((_cmd: string[]) => ({
      stdout: new Response("").body,
      exited: Promise.resolve(1),
      kill: vi.fn(),
    }))
    await runResetSubcommand(["--yes"])
    expect(output()).toContain("tmux: no sessions on `kobe-test`")
  })

  it("--hard deletes tasks.json and state.json", async () => {
    const tasksPath = join(home, ".kobe", "tasks.json")
    const statePath = join(home, ".config", "kobe", "state.json")
    mkdirSync(join(home, ".config", "kobe"), { recursive: true })
    writeFileSync(tasksPath, JSON.stringify({ tasks: [{ id: "a" }] }), "utf8")
    writeFileSync(statePath, "{}", "utf8")

    await runResetSubcommand(["--hard", "--yes"])

    expect(existsSync(tasksPath)).toBe(false)
    expect(existsSync(statePath)).toBe(false)
    const out = output()
    expect(out).toContain("DELETE the task index (1 task(s))")
    expect(out).toContain("removed task index")
    expect(out).toContain("removed UI state")
  })

  it("--hard reports 'already absent' when the state files don't exist", async () => {
    await runResetSubcommand(["--hard", "--yes"])
    const out = output()
    expect(out).toContain("task index: already absent")
    expect(out).toContain("UI state: already absent")
  })

  it("without --hard, keeps the task list and never mentions deletion", async () => {
    await runResetSubcommand(["--yes"])
    const out = output()
    expect(out).toContain("your task list & worktrees are kept")
    expect(out).not.toContain("DELETE")
  })

  it("on a TTY without --yes, a 'y' answer proceeds with the reset", async () => {
    ;(process.stdin as unknown as { isTTY: boolean }).isTTY = true
    mocks.confirmAnswer = "y"
    await runResetSubcommand([])
    // Once for the daemon, once for the standalone pty host — reset is the
    // pty host's one teardown path besides idle-exit.
    expect(mocks.stopDaemonProcess).toHaveBeenCalledTimes(2)
    expect(output()).toContain("reset complete")
  })

  it("on a TTY without --yes, anything but yes aborts with nothing changed", async () => {
    ;(process.stdin as unknown as { isTTY: boolean }).isTTY = true
    mocks.confirmAnswer = "n"
    await runResetSubcommand(["--hard"])
    expect(output()).toContain("aborted — nothing changed")
    expect(mocks.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("--hard reports (but survives) a state file it cannot remove", async () => {
    // A DIRECTORY at the tasks.json path makes unlink fail with a non-ENOENT
    // error — the reset must report it and still finish the rest of the wipe.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    mkdirSync(join(home, ".kobe", "tasks.json"), { recursive: true })
    await runResetSubcommand(["--hard", "--yes"])
    expect(errorSpy.mock.calls.join("\n")).toContain("failed to remove task index")
    const out = output()
    expect(out).toContain("UI state: already absent")
    expect(out).toContain("reset complete")
    errorSpy.mockRestore()
  })
})
