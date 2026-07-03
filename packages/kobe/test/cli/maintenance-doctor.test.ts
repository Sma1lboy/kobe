/**
 * `kobe doctor` (`runDoctorSubcommand`) — read-only diagnostic report.
 * Real filesystem under a per-test KOBE_HOME_DIR tempdir (paths.ts + env.ts
 * both resolve off that env var), only the daemon socket client, tmux
 * client, and skill-install state are mocked — those would otherwise dial a
 * real socket / shell out to tmux / touch the real OS home dir.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  daemonRequest: vi.fn(),
  daemonClose: vi.fn(),
  tmuxAvailable: vi.fn(),
  tmuxArgs: vi.fn((..._args: string[]) => ["true"]),
  termAllPaneGroups: vi.fn(),
  kobeSkillState: vi.fn(),
  bunSpawn: vi.fn((_cmd: string[], _opts?: unknown) => ({
    stdout: new Response("").body,
    exited: Promise.resolve(0),
    kill: vi.fn(),
  })),
}))

vi.mock("@sma1lboy/kobe-daemon/client", () => ({
  KobeDaemonClient: vi.fn().mockImplementation(() => ({
    request: mocks.daemonRequest,
    close: mocks.daemonClose,
  })),
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

vi.mock("../../src/lib/skill-install.ts", () => ({
  SKILL_INSTALL_COMMAND: "kobe skill install",
  kobeSkillState: mocks.kobeSkillState,
}))

import { runDoctorSubcommand } from "../../src/cli/maintenance.ts"

let home: string
let originalHome: string | undefined
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-doctor-"))
  process.env.KOBE_HOME_DIR = home
  mkdirSync(join(home, ".kobe"), { recursive: true })

  mocks.daemonRequest.mockReset()
  mocks.daemonClose.mockReset()
  mocks.tmuxAvailable.mockReset().mockResolvedValue(false)
  mocks.tmuxArgs.mockReset().mockImplementation((..._args: string[]) => ["true"])
  mocks.termAllPaneGroups.mockReset()
  mocks.kobeSkillState.mockReset().mockReturnValue({
    installed: true,
    installedVersion: 2,
    currentVersion: 2,
    stale: false,
  })
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
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
  // NOTE: vi.restoreAllMocks() would also reset the vi.fn()-based
  // KobeDaemonClient class mock's mockImplementation (it's a mock too, set
  // once in the vi.mock factory above) — restore only the real-global spies.
  logSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
  vi.unstubAllGlobals()
})

function output(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n")
}

describe("runDoctorSubcommand", () => {
  it("--help prints usage and does not probe anything", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runDoctorSubcommand(["--help"])
    expect(writeSpy.mock.calls.join("")).toContain("Usage: kobe doctor")
    expect(mocks.daemonRequest).not.toHaveBeenCalled()
  })

  it("rejects an unexpected positional argument with usage + exit 2", async () => {
    await expect(runDoctorSubcommand(["bogus"])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain('unexpected argument "bogus"')
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it("reports a running daemon with matching build version", async () => {
    mocks.daemonRequest.mockResolvedValue({
      daemonPid: 4242,
      uptimeMs: 65_000,
      taskCount: 3,
      attachedClients: 1,
      kobeVersion: "0.0.0-test",
    })
    const { CURRENT_VERSION } = await import("../../src/version.ts")
    // Force the daemon-reported version to match CURRENT_VERSION so the
    // "no stale build" branch is exercised.
    mocks.daemonRequest.mockResolvedValue({
      daemonPid: 4242,
      uptimeMs: 65_000,
      taskCount: 3,
      attachedClients: 1,
      kobeVersion: CURRENT_VERSION,
    })
    await runDoctorSubcommand([])
    const out = output()
    expect(out).toContain("daemon:  ✓ running (pid 4242, up 1m 5s, 3 task(s), 1 client(s))")
    expect(out).toContain(`build: v${CURRENT_VERSION}`)
    expect(out).not.toContain("stale build")
    expect(mocks.daemonClose).toHaveBeenCalledTimes(1)
  })

  it("flags a stale-build daemon (daemon version differs from the launching binary)", async () => {
    mocks.daemonRequest.mockResolvedValue({
      daemonPid: 1,
      uptimeMs: 1000,
      taskCount: 0,
      attachedClients: 0,
      kobeVersion: "0.0.0-ancient",
    })
    await runDoctorSubcommand([])
    const out = output()
    expect(out).toContain("stale build: daemon is v0.0.0-ancient")
    expect(out).toContain("kobe daemon restart")
  })

  it("reports a wedged daemon (live pid, socket unreachable)", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("ECONNREFUSED"))
    writeFileSync(join(home, ".kobe", "daemon.pid"), String(process.pid), "utf8")
    await runDoctorSubcommand([])
    const out = output()
    expect(out).toContain(`WEDGED — process alive (pid ${process.pid})`)
    expect(out).toContain("kobe reset")
  })

  it("reports no daemon running with a stale pidfile pointing at a dead pid", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("ECONNREFUSED"))
    // A pid vanishingly unlikely to be alive.
    writeFileSync(join(home, ".kobe", "daemon.pid"), "999999", "utf8")
    await runDoctorSubcommand([])
    const out = output()
    expect(out).toContain("stale pidfile → pid 999999 is gone")
  })

  it("reports no daemon running and no pidfile at all", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("ECONNREFUSED"))
    await runDoctorSubcommand([])
    expect(output()).toContain("daemon:  ✗ not running (no pidfile)")
  })

  it("tails daemon.log when the daemon is unreachable", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("down"))
    writeFileSync(join(home, ".kobe", "daemon.log"), "line one\nline two\n\nline three\n", "utf8")
    await runDoctorSubcommand([])
    const out = output()
    expect(out).toContain("last lines of daemon.log:")
    expect(out).toContain("│ line one")
    expect(out).toContain("│ line three")
  })

  it("reports tmux session count when tmux is available", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("down"))
    mocks.tmuxAvailable.mockResolvedValue(true)
    mocks.bunSpawn.mockImplementation((_cmd: string[]) => ({
      stdout: new Response("one\ntwo\nthree\n").body,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    }))
    await runDoctorSubcommand([])
    expect(output()).toContain("tmux:    3 kobe session(s) on `kobe-test` socket")
  })

  it("reports tmux missing when unavailable", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("down"))
    mocks.tmuxAvailable.mockResolvedValue(false)
    await runDoctorSubcommand([])
    expect(output()).toContain("tmux:    ✗ not found on PATH")
  })

  it("reports skill not installed / stale / installed variants", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("down"))

    mocks.kobeSkillState.mockReturnValue({
      installed: false,
      installedVersion: null,
      currentVersion: 2,
      stale: false,
    })
    await runDoctorSubcommand([])
    expect(output()).toContain("skill:   ✗ kobe agent skill not installed")

    logSpy.mockClear()
    mocks.kobeSkillState.mockReturnValue({
      installed: true,
      installedVersion: 1,
      currentVersion: 2,
      stale: true,
    })
    await runDoctorSubcommand([])
    expect(output()).toContain("skill:   ⚠ kobe agent skill out of date (v1; this kobe wants v2)")

    logSpy.mockClear()
    mocks.kobeSkillState.mockReturnValue({
      installed: true,
      installedVersion: 2,
      currentVersion: 2,
      stale: false,
    })
    await runDoctorSubcommand([])
    expect(output()).toContain("skill:   ✓ kobe agent skill installed (v2)")
  })

  it("reports tasks.json / state.json / daemon.log presence and task count", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("down"))
    writeFileSync(join(home, ".kobe", "tasks.json"), JSON.stringify({ tasks: [{ id: "a" }, { id: "b" }] }), "utf8")
    await runDoctorSubcommand([])
    const out = output()
    expect(out).toContain("tasks.json: present")
    expect(out).toContain("2 task(s)")
    expect(out).toContain("state.json: absent")
  })
})
