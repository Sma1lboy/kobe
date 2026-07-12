import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  close: vi.fn(),
  kobeSkillState: vi.fn(),
}))

vi.mock("@sma1lboy/kobe-daemon/client", () => ({
  KobeDaemonClient: vi.fn().mockImplementation(() => ({
    request: mocks.request,
    close: mocks.close,
  })),
}))

vi.mock("../../src/lib/skill-install.ts", () => ({
  SKILL_INSTALL_COMMAND: "kobe skill install",
  kobeSkillState: mocks.kobeSkillState,
}))

import { runDoctorSubcommand } from "../../src/cli/doctor-cmd.ts"

let home: string
let originalHome: string | undefined
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-doctor-"))
  process.env.KOBE_HOME_DIR = home
  mkdirSync(join(home, ".kobe"), { recursive: true })
  mocks.request.mockReset()
  mocks.close.mockReset()
  mocks.kobeSkillState.mockReset().mockReturnValue({
    installed: true,
    installedVersion: 3,
    currentVersion: 3,
    stale: false,
  })
  vi.stubGlobal("Bun", { version: "0.0.0-test" })
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
  logSpy.mockRestore()
  vi.unstubAllGlobals()
})

function output(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join("\n")
}

describe("runDoctorSubcommand", () => {
  it("reports daemon and Hosted PTY health without a tmux section", async () => {
    mocks.request.mockImplementation(async (name: string) => {
      if (name === "daemon.status") {
        return { daemonPid: 42, uptimeMs: 65_000, taskCount: 2, attachedClients: 1 }
      }
      if (name === "pty.list") {
        return {
          sessions: [
            { key: "task-a::tab-1", alive: true },
            { key: "task-b::tab-1", alive: false },
          ],
        }
      }
      throw new Error(`unexpected request ${name}`)
    })

    await runDoctorSubcommand([])

    expect(output()).toContain("daemon:  ✓ running (pid 42, up 1m 5s, 2 task(s), 1 client(s))")
    expect(output()).toContain("pty host: ✓ running (2 session(s), 1 live)")
    expect(output()).not.toContain("tmux")
  })

  it("help describes a read-only daemon and Hosted PTY diagnosis", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runDoctorSubcommand(["--help"])
    expect(writeSpy.mock.calls.join("")).toContain("daemon / Hosted PTY / state")
    expect(mocks.request).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })
})
