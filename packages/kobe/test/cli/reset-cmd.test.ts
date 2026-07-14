import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  stopDaemonProcess: vi.fn(),
  stopLegacyTmux: vi.fn(),
  stampResetGate: vi.fn(),
}))

vi.mock("@sma1lboy/kobe-daemon/daemon/lifecycle", () => ({
  stopDaemonProcess: mocks.stopDaemonProcess,
}))

vi.mock("../../src/cli/legacy-tmux.ts", () => ({
  stopLegacyTmux: mocks.stopLegacyTmux,
}))

vi.mock("../../src/cli/reset-gate.ts", () => ({
  stampResetGate: mocks.stampResetGate,
}))

import { runResetSubcommand } from "../../src/cli/reset-cmd.ts"

let home: string
let originalHome: string | undefined
let originalExitCode: number | string | null | undefined
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  originalExitCode = process.exitCode
  process.exitCode = 0
  home = mkdtempSync(join(tmpdir(), "kobe-reset-"))
  process.env.KOBE_HOME_DIR = home
  mkdirSync(join(home, ".kobe"), { recursive: true })
  mocks.stopDaemonProcess.mockReset().mockResolvedValue({ pid: null, method: "absent" })
  mocks.stopLegacyTmux.mockReset().mockResolvedValue({ status: "absent", sessions: 0, signalledGroups: 0 })
  mocks.stampResetGate.mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  process.exitCode = originalExitCode
  rmSync(home, { recursive: true, force: true })
  logSpy.mockRestore()
  errorSpy.mockRestore()
})

function output(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join("\n")
}

describe("runResetSubcommand", () => {
  it("stops current runtimes before safely cleaning legacy tmux", async () => {
    mocks.stopDaemonProcess
      .mockResolvedValueOnce({ pid: 11, method: "sigterm" })
      .mockResolvedValueOnce({ pid: 12, method: "graceful" })
    mocks.stopLegacyTmux.mockResolvedValue({ status: "stopped", sessions: 2, signalledGroups: 8 })

    await runResetSubcommand(["--yes"])

    expect(mocks.stopDaemonProcess).toHaveBeenCalledTimes(2)
    expect(mocks.stopLegacyTmux).toHaveBeenCalledTimes(1)
    expect(mocks.stopLegacyTmux.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.stopDaemonProcess.mock.invocationCallOrder[1] ?? 0,
    )
    expect(output()).toContain("pty host: stopped via graceful (pid 12)")
    expect(output()).toContain("legacy tmux: stopped 2 session(s) after signalling 8 pane group(s)")
    expect(mocks.stampResetGate).toHaveBeenCalledTimes(1)
  })

  it("hard reset removes task and UI state while preserving worktrees", async () => {
    const tasksPath = join(home, ".kobe", "tasks.json")
    const statePath = join(home, ".config", "kobe", "state.json")
    mkdirSync(join(home, ".config", "kobe"), { recursive: true })
    writeFileSync(tasksPath, JSON.stringify({ tasks: [{ id: "a" }] }))
    writeFileSync(statePath, "{}")

    await runResetSubcommand(["--hard", "--yes"])

    expect(existsSync(tasksPath)).toBe(false)
    expect(existsSync(statePath)).toBe(false)
    expect(output()).toContain("NOT touch your git worktrees")
    expect(mocks.stampResetGate).not.toHaveBeenCalled()
  })

  it("does not wipe state or stamp reset complete when legacy cleanup fails", async () => {
    const tasksPath = join(home, ".kobe", "tasks.json")
    const statePath = join(home, ".config", "kobe", "state.json")
    mkdirSync(join(home, ".config", "kobe"), { recursive: true })
    writeFileSync(tasksPath, JSON.stringify({ tasks: [{ id: "a" }] }))
    writeFileSync(statePath, "{}")
    mocks.stopLegacyTmux.mockResolvedValue({
      status: "failed",
      sessions: 1,
      signalledGroups: 1,
      error: "server still running",
    })

    await runResetSubcommand(["--hard", "--yes"])
    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith("  legacy tmux: cleanup failed — server still running")
    expect(existsSync(tasksPath)).toBe(true)
    expect(existsSync(statePath)).toBe(true)
    expect(mocks.stampResetGate).not.toHaveBeenCalled()
    expect(output()).not.toContain("reset complete")
  })

  it("does not report success when a hard-reset state path cannot be removed", async () => {
    const tasksPath = join(home, ".kobe", "tasks.json")
    mkdirSync(tasksPath)

    await expect(runResetSubcommand(["--hard", "--yes"])).rejects.toThrow("failed to remove task index")
    expect(output()).not.toContain("reset complete")
  })

  it("help names Hosted PTY and legacy tmux cleanup", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runResetSubcommand(["--help"])
    const help = writeSpy.mock.calls.join("")
    expect(help).toContain("Hosted PTY host")
    expect(help).toContain("pre-v0.8 tmux sessions")
    writeSpy.mockRestore()
  })
})
