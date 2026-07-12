import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  stopDaemonProcess: vi.fn(),
  stampResetGate: vi.fn(),
}))

vi.mock("@sma1lboy/kobe-daemon/daemon/lifecycle", () => ({
  stopDaemonProcess: mocks.stopDaemonProcess,
}))

vi.mock("../../src/cli/reset-gate.ts", () => ({
  stampResetGate: mocks.stampResetGate,
}))

import { runResetSubcommand } from "../../src/cli/reset-cmd.ts"

let home: string
let originalHome: string | undefined
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-reset-"))
  process.env.KOBE_HOME_DIR = home
  mkdirSync(join(home, ".kobe"), { recursive: true })
  mocks.stopDaemonProcess.mockReset().mockResolvedValue({ pid: null, method: "absent" })
  mocks.stampResetGate.mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
  logSpy.mockRestore()
})

function output(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join("\n")
}

describe("runResetSubcommand", () => {
  it("stops the daemon and Hosted PTY host without invoking tmux", async () => {
    mocks.stopDaemonProcess
      .mockResolvedValueOnce({ pid: 11, method: "sigterm" })
      .mockResolvedValueOnce({ pid: 12, method: "graceful" })

    await runResetSubcommand(["--yes"])

    expect(mocks.stopDaemonProcess).toHaveBeenCalledTimes(2)
    expect(output()).toContain("pty host: stopped via graceful (pid 12)")
    expect(output()).not.toContain("tmux")
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

  it("help names Hosted PTY and contains no tmux contract", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runResetSubcommand(["--help"])
    const help = writeSpy.mock.calls.join("")
    expect(help).toContain("stop the standalone Hosted PTY host")
    expect(help).not.toContain("tmux")
    writeSpy.mockRestore()
  })
})
