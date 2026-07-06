import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  daemonRequest: vi.fn(),
  daemonClose: vi.fn(),
  connectOrStartDaemon: vi.fn(),
  stopDaemonProcess: vi.fn(),
  installDaemonCrashHandlers: vi.fn(),
  startDaemonServer: vi.fn(),
  createKobeCore: vi.fn(),
}))

vi.mock("@sma1lboy/kobe-daemon/client", () => ({
  KobeDaemonClient: vi.fn().mockImplementation(() => ({
    request: mocks.daemonRequest,
    close: mocks.daemonClose,
  })),
}))

vi.mock("@sma1lboy/kobe-daemon/client/daemon-process", () => ({
  connectOrStartDaemon: mocks.connectOrStartDaemon,
}))

vi.mock("@sma1lboy/kobe-daemon/daemon/crash-log", () => ({
  installDaemonCrashHandlers: mocks.installDaemonCrashHandlers,
}))

vi.mock("@sma1lboy/kobe-daemon/daemon/lifecycle", () => ({
  stopDaemonProcess: mocks.stopDaemonProcess,
}))

vi.mock("@sma1lboy/kobe-daemon/daemon/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sma1lboy/kobe-daemon/daemon/server")>()
  return { ...actual, startDaemonServer: mocks.startDaemonServer }
})

vi.mock("../../src/core/index.ts", () => ({
  createKobeCore: mocks.createKobeCore,
}))

import { runDaemonSubcommand } from "../../src/cli/daemon-cmd.ts"

let home: string
let originalHome: string | undefined
let originalWebPort: string | undefined
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  originalWebPort = process.env.KOBE_DAEMON_WEB_PORT
  home = mkdtempSync(join(tmpdir(), "kobe-daemon-cmd-"))
  process.env.KOBE_HOME_DIR = home
  mkdirSync(join(home, ".kobe"), { recursive: true })

  mocks.daemonRequest.mockReset()
  mocks.daemonClose.mockReset()
  mocks.connectOrStartDaemon.mockReset()
  mocks.stopDaemonProcess.mockReset().mockResolvedValue({ pid: null, method: "absent" })
  mocks.installDaemonCrashHandlers.mockReset()
  mocks.startDaemonServer.mockReset()
  mocks.createKobeCore.mockReset()

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
  process.exitCode = undefined
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  if (originalWebPort === undefined) Reflect.deleteProperty(process.env, "KOBE_DAEMON_WEB_PORT")
  else process.env.KOBE_DAEMON_WEB_PORT = originalWebPort
  rmSync(home, { recursive: true, force: true })
  logSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
  process.exitCode = undefined
})

function output(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n")
}

describe("kobe daemon status", () => {
  it("prints the daemon's status JSON and closes the socket", async () => {
    mocks.daemonRequest.mockResolvedValue({ daemonPid: 7, taskCount: 2 })
    await runDaemonSubcommand(["status"])
    expect(mocks.daemonRequest).toHaveBeenCalledWith("daemon.status")
    expect(JSON.parse(output())).toEqual({ daemonPid: 7, taskCount: 2 })
    expect(mocks.daemonClose).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBeUndefined()
  })

  it("status is the default command when argv is empty", async () => {
    mocks.daemonRequest.mockResolvedValue({ ok: true })
    await runDaemonSubcommand([])
    expect(mocks.daemonRequest).toHaveBeenCalledWith("daemon.status")
  })

  it("reports a stale pidfile and sets exitCode 1 when the socket doesn't answer", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("ECONNREFUSED"))
    writeFileSync(join(home, ".kobe", "daemon.pid"), "4242", "utf8")
    await runDaemonSubcommand(["status"])
    expect(output()).toContain("stale pidfile pid=4242")
    expect(process.exitCode).toBe(1)
    expect(mocks.daemonClose).toHaveBeenCalledTimes(1)
  })

  it("reports no daemon running when there is no pidfile either", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("ECONNREFUSED"))
    await runDaemonSubcommand(["status"])
    expect(output()).toContain("no daemon running at")
    expect(process.exitCode).toBe(1)
  })
})

describe("kobe daemon stop", () => {
  it("requests daemon.stop and reports success", async () => {
    mocks.daemonRequest.mockResolvedValue({})
    await runDaemonSubcommand(["stop"])
    expect(mocks.daemonRequest).toHaveBeenCalledWith("daemon.stop")
    expect(output()).toContain("stop requested")
    expect(mocks.daemonClose).toHaveBeenCalledTimes(1)
  })

  it("exits cleanly (no error) when no daemon is running", async () => {
    mocks.daemonRequest.mockRejectedValue(new Error("ECONNREFUSED"))
    await runDaemonSubcommand(["stop"])
    expect(output()).toContain("no daemon running at")
    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
})

describe("kobe daemon restart", () => {
  it("stops the old daemon, respawns detached, and closes the probe client", async () => {
    const next = { close: vi.fn() }
    mocks.connectOrStartDaemon.mockResolvedValue(next)
    await runDaemonSubcommand(["restart"])
    expect(mocks.stopDaemonProcess).toHaveBeenCalledTimes(1)
    expect(mocks.connectOrStartDaemon).toHaveBeenCalledTimes(1)
    expect(next.close).toHaveBeenCalledTimes(1)
    expect(output()).toContain("restarted, listening on")
  })
})

describe("kobe daemon start", () => {
  it("installs crash handlers, creates the core, and starts the server with the resolved web port", async () => {
    Reflect.deleteProperty(process.env, "KOBE_DAEMON_WEB_PORT")
    const core = { orchestrator: { tag: "orch" }, homeDir: home, close: vi.fn() }
    mocks.createKobeCore.mockResolvedValue(core)
    mocks.startDaemonServer.mockResolvedValue({ socketPath: "/tmp/x.sock", webPort: 5174, close: vi.fn() })

    await runDaemonSubcommand(["start"])

    expect(mocks.installDaemonCrashHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.startDaemonServer).toHaveBeenCalledWith(
      core.orchestrator,
      expect.objectContaining({ homeDir: home, webPort: 5174 }),
    )
    const out = output()
    expect(out).toContain("listening on /tmp/x.sock")
    expect(out).toContain("web transport listening on http://127.0.0.1:5174")
  })

  it("KOBE_DAEMON_WEB_PORT=off disables the web transport", async () => {
    process.env.KOBE_DAEMON_WEB_PORT = "off"
    mocks.createKobeCore.mockResolvedValue({ orchestrator: {}, homeDir: home, close: vi.fn() })
    mocks.startDaemonServer.mockResolvedValue({ socketPath: "/tmp/x.sock", webPort: undefined, close: vi.fn() })

    await runDaemonSubcommand(["start"])

    expect(mocks.startDaemonServer).toHaveBeenCalledWith({}, expect.objectContaining({ webPort: undefined }))
    expect(output()).not.toContain("web transport")
  })

  it("a custom numeric KOBE_DAEMON_WEB_PORT is passed through", async () => {
    process.env.KOBE_DAEMON_WEB_PORT = "6000"
    mocks.createKobeCore.mockResolvedValue({ orchestrator: {}, homeDir: home, close: vi.fn() })
    mocks.startDaemonServer.mockResolvedValue({ socketPath: "/tmp/x.sock", webPort: 6000, close: vi.fn() })
    await runDaemonSubcommand(["start"])
    expect(mocks.startDaemonServer).toHaveBeenCalledWith({}, expect.objectContaining({ webPort: 6000 }))
  })
})

describe("usage", () => {
  it("--help prints usage without touching the daemon", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runDaemonSubcommand(["--help"])
    expect(outSpy.mock.calls.join("")).toContain("Usage: kobe daemon")
    expect(mocks.daemonRequest).not.toHaveBeenCalled()
    outSpy.mockRestore()
  })

  it("unknown command prints usage to stderr and exits 2", async () => {
    await expect(runDaemonSubcommand(["bogus"])).rejects.toThrow("exit 2")
    expect(errSpy.mock.calls.join("")).toContain('unknown command "bogus"')
    expect(errSpy.mock.calls.join("")).toContain("Usage: kobe daemon")
  })
})
