import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  close: vi.fn(),
  inspectLegacyTmux: vi.fn(),
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

vi.mock("../../src/cli/legacy-tmux.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/legacy-tmux.ts")>()
  return { ...actual, inspectLegacyTmux: mocks.inspectLegacyTmux }
})

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
  mocks.inspectLegacyTmux.mockReset().mockResolvedValue({
    available: true,
    version: "tmux 3.6b",
    sessions: [],
    panePids: [],
    processes: [],
    error: null,
  })
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
  it("reports daemon, Hosted PTY, and installed tmux health", async () => {
    mocks.request.mockImplementation(async (name: string) => {
      if (name === "daemon.status") {
        return { daemonPid: 42, uptimeMs: 65_000, taskCount: 2, attachedClients: 1 }
      }
      if (name === "pty.list") {
        return {
          sessions: [
            { key: "task-a::tab-1", alive: true, parked: false },
            { key: "task-b::tab-1", alive: false, parked: true },
          ],
          pid: 99,
          rssBytes: 12 * 1024 * 1024,
          stats: {
            ringBytes: 128 * 1024,
            ringCapacityBytes: 1024 * 1024,
            parkedSessions: 1,
            parkedScreenBytes: 100 * 1024,
            parkRestoreDeltas: 7,
            parkRestoreFallbacks: 2,
          },
        }
      }
      throw new Error(`unexpected request ${name}`)
    })

    await runDoctorSubcommand([])

    expect(output()).toContain("daemon:  ✓ running (pid 42, up 1m 5s, 2 task(s), 1 client(s))")
    expect(output()).toContain("pty host: ✓ running (2 session(s), 1 live, 1 parked)")
    expect(output()).toContain("pid 99, 12.0 MB RSS")
    expect(output()).toContain("ring: 128.0 KB / 1.0 MB")
    expect(output()).toContain("parked screens: 100.0 KB")
    expect(output()).toContain("park wakes: 7 delta, 2 full replay fallback")
    expect(output()).toContain("legacy tmux: tmux 3.6b — no sessions on `kobe`")
  })

  it("reports legacy process counts and RSS without mutating them", async () => {
    mocks.request.mockRejectedValue(new Error("not running"))
    mocks.inspectLegacyTmux.mockResolvedValue({
      available: true,
      version: "tmux 3.6b",
      sessions: ["kobe-a"],
      panePids: [501],
      processes: [
        { pid: 501, pgid: 501, rssKb: 4096, command: "bun" },
        { pid: 510, pgid: 501, rssKb: 2048, command: "claude" },
      ],
      error: null,
    })

    await runDoctorSubcommand([])

    expect(output()).toContain("legacy tmux: ⚠ tmux 3.6b — 1 pre-v0.8 session(s)")
    expect(output()).toContain("2 process(es) across 1 pane(s), 6.0 MB RSS total")
    expect(output()).toContain("bun: 1 proc, 4.0 MB")
    expect(output()).toContain("claude: 1 proc, 2.0 MB")
    expect(mocks.inspectLegacyTmux).toHaveBeenCalledTimes(1)
  })

  it("help describes a read-only daemon, Hosted PTY, and legacy tmux diagnosis", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runDoctorSubcommand(["--help"])
    expect(writeSpy.mock.calls.join("")).toContain("daemon / Hosted PTY / legacy tmux / state")
    expect(mocks.request).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })
})
