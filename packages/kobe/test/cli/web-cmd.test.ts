/**
 * `kobe web` (`runWebSubcommand`). ensureDaemonReachable is mocked (it
 * would spawn a real daemon) and `fetch` is stubbed to script the daemon
 * web-transport health probe. The success path never resolves by design
 * (it parks on a forever-promise), so it's asserted via waitFor without
 * awaiting the returned promise.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  ensureDaemonReachable: vi.fn(),
  bunSpawn: vi.fn(),
}))

vi.mock("@sma1lboy/kobe-daemon/client/daemon-process", () => ({
  ensureDaemonReachable: mocks.ensureDaemonReachable,
}))

import { runWebSubcommand } from "../../src/cli/web-cmd.ts"

let outSpy: MockInstance<typeof process.stdout.write>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>
let fetchMock: ReturnType<typeof vi.fn>
let originalWebPort: string | undefined
let originalStaticDir: string | undefined

beforeEach(() => {
  originalWebPort = process.env.KOBE_DAEMON_WEB_PORT
  originalStaticDir = process.env.KOBE_DAEMON_WEB_STATIC_DIR

  mocks.ensureDaemonReachable.mockReset().mockResolvedValue("/tmp/daemon.sock")
  mocks.bunSpawn.mockReset().mockReturnValue({
    stdout: new Response("").body,
    exited: new Promise(() => {}),
    kill: vi.fn(),
  })
  vi.stubGlobal("Bun", { spawn: mocks.bunSpawn })
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)

  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  if (originalWebPort === undefined) Reflect.deleteProperty(process.env, "KOBE_DAEMON_WEB_PORT")
  else process.env.KOBE_DAEMON_WEB_PORT = originalWebPort
  if (originalStaticDir === undefined) Reflect.deleteProperty(process.env, "KOBE_DAEMON_WEB_STATIC_DIR")
  else process.env.KOBE_DAEMON_WEB_STATIC_DIR = originalStaticDir
  outSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
  vi.unstubAllGlobals()
})

function out(): string {
  return outSpy.mock.calls.map((c) => String(c[0])).join("")
}
function err(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("")
}

describe("runWebSubcommand", () => {
  it("--help prints usage and starts nothing", async () => {
    await runWebSubcommand(["--help"])
    expect(out()).toContain("Usage: kobe web")
    expect(mocks.ensureDaemonReachable).not.toHaveBeenCalled()
  })

  it("--port with a non-number exits 2", async () => {
    await expect(runWebSubcommand(["--port", "abc"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--port needs a number")
  })

  it("routes-only success: sets the port env, verifies the health marker, prints the URL + home label", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve("kobe-web") })

    // The success path parks on a forever-promise — don't await it.
    void runWebSubcommand(["--routes-only", "--port", "5199"])

    await vi.waitFor(() => {
      expect(out()).toContain("kobe daemon web transport listening on http://localhost:5199 (routes only)")
    })
    expect(process.env.KOBE_DAEMON_WEB_PORT).toBe("5199")
    expect(mocks.ensureDaemonReachable).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:5199/__kobe_web", expect.anything())
    expect(out()).toContain("home:")
    // routes-only never starts the PTY sidecar.
    expect(mocks.bunSpawn).not.toHaveBeenCalled()
  })

  it("fails with exit 1 when the daemon web transport does not answer the health probe", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"))
    await expect(runWebSubcommand(["--routes-only"])).rejects.toThrow("exit 1")
    expect(err()).toContain("daemon web transport is not reachable on :5174")
    expect(err()).toContain("kobe daemon restart")
  })

  it("fails with exit 1 on an unexpected health marker (non-kobe service on the port)", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve("something-else") })
    await expect(runWebSubcommand(["--routes-only"])).rejects.toThrow("exit 1")
    expect(err()).toContain("unexpected daemon web health marker on :5174: something-else")
  })
})
