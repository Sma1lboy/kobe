/**
 * `kobe web` full-launch path (`runWebSubcommand` without --routes-only) —
 * sibling of web-cmd.test.ts (which covers flag parsing + the routes-only
 * health probes). Here `node:fs.existsSync` is mocked so the SPA dist /
 * PTY-server resolution can be scripted, `fetch` is routed per-URL to
 * script the daemon-web + PTY-port health probes, and `Bun.spawn` answers
 * both the `lsof` port scans and the PTY sidecar spawn. The success path
 * parks on a forever-promise by design, so it is asserted via waitFor
 * without awaiting the returned promise.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  ensureDaemonReachable: vi.fn(),
  existsSync: vi.fn((_p: string) => false),
}))

vi.mock("@sma1lboy/kobe-daemon/client/daemon-process", () => ({
  ensureDaemonReachable: mocks.ensureDaemonReachable,
}))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, existsSync: (p: string) => mocks.existsSync(String(p)) }
})

import { runWebSubcommand } from "../../src/cli/web-cmd.ts"

type SpawnCall = { cmd: string[]; opts: Record<string, unknown> | undefined }

let outSpy: MockInstance<typeof process.stdout.write>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>
let onSpy: MockInstance<typeof process.on>
let killSpy: MockInstance<typeof process.kill>
let fetchMock: ReturnType<typeof vi.fn>
let spawnCalls: SpawnCall[]
let lsofOutputs: string[]
let ptyProc: { exited: Promise<number>; kill: ReturnType<typeof vi.fn> }
let resolvePtyExited: (code: number) => void
let signalHandlers: Map<string, () => void>
let savedEnv: Record<string, string | undefined>

/** Route fetch by URL substring; unrouted URLs reject (loudly visible). */
function routeFetch(routes: Record<string, { ok?: boolean; body?: string } | Error>): void {
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url)
    for (const [needle, res] of Object.entries(routes)) {
      if (!u.includes(needle)) continue
      if (res instanceof Error) throw res
      return { ok: res.ok ?? true, text: () => Promise.resolve(res.body ?? "") }
    }
    throw new Error(`unrouted fetch: ${u}`)
  })
}

beforeEach(() => {
  savedEnv = {
    KOBE_DAEMON_WEB_PORT: process.env.KOBE_DAEMON_WEB_PORT,
    KOBE_DAEMON_WEB_STATIC_DIR: process.env.KOBE_DAEMON_WEB_STATIC_DIR,
    KOBE_HOME_DIR: process.env.KOBE_HOME_DIR,
  }
  mocks.ensureDaemonReachable.mockReset().mockResolvedValue("/tmp/daemon.sock")
  mocks.existsSync.mockReset().mockReturnValue(true)

  spawnCalls = []
  lsofOutputs = []
  ptyProc = {
    exited: new Promise<number>((r) => {
      resolvePtyExited = r
    }),
    kill: vi.fn(),
  }
  vi.stubGlobal("Bun", {
    spawn: vi.fn((cmd: string[], opts?: Record<string, unknown>) => {
      spawnCalls.push({ cmd, opts })
      if (cmd[0] === "lsof") {
        return { stdout: new Response(lsofOutputs.shift() ?? "").body, exited: Promise.resolve(0), kill: vi.fn() }
      }
      return ptyProc
    }),
  })
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)

  signalHandlers = new Map()
  onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
    signalHandlers.set(event, handler)
    return process
  }) as never)
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  outSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
  onSpy.mockRestore()
  killSpy.mockRestore()
  vi.unstubAllGlobals()
})

function out(): string {
  return outSpy.mock.calls.map((c) => String(c[0])).join("")
}
function err(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("")
}

describe("runWebSubcommand full launch", () => {
  it("fails with exit 1 when the built SPA is missing from this build", async () => {
    mocks.existsSync.mockReturnValue(false)
    await expect(runWebSubcommand([])).rejects.toThrow("exit 1")
    expect(err()).toContain("web assets are missing from this kobe build")
    expect(mocks.ensureDaemonReachable).not.toHaveBeenCalled()
  })

  it("launches: verifies web assets, takes over the PTY port (killing stale kobe PIDs), spawns the sidecar", async () => {
    process.env.KOBE_HOME_DIR = "/tmp/sandbox-home"
    routeFetch({
      "127.0.0.1:5180/__kobe_web": { body: "kobe-web" },
      "127.0.0.1:5180/": { ok: true },
      "localhost:5182/__kobe_web": { body: "kobe-web" }, // stale kobe-web on the PTY port
    })
    // lsof: takeover listing → two pids (one dies, one throws "already gone");
    // first deadline poll still sees one (forces the 100ms wait), second is clear.
    lsofOutputs = [`4242\n555\n${process.pid}\n`, "4242\n", ""]
    killSpy.mockImplementation((pid: number) => {
      if (pid === 555) throw new Error("ESRCH")
      return true
    })

    void runWebSubcommand(["--port", "5180"])
    await vi.waitFor(() => {
      expect(out()).toContain("kobe web → http://localhost:5180")
    })

    // Own pid is never a takeover target; both stale pids got SIGTERM.
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM")
    expect(killSpy).toHaveBeenCalledWith(555, "SIGTERM")
    expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGTERM")

    // The PTY sidecar runs under node with the web/pty ports wired in.
    const node = spawnCalls.find((c) => c.cmd[0] === "node")
    expect(node).toBeDefined()
    const env = node?.opts?.env as Record<string, string>
    expect(env.KOBE_DAEMON_WEB_PORT).toBe("5180")
    expect(env.KOBE_PTY_PORT).toBe("5182")
    expect(process.env.KOBE_DAEMON_WEB_STATIC_DIR).toBeTruthy()

    // The sandbox home is surfaced, never a mystery.
    expect(out()).toContain("sandbox: /tmp/sandbox-home")

    // SIGINT/SIGTERM stop the sidecar and exit 0.
    const sigint = signalHandlers.get("SIGINT")
    expect(sigint).toBeDefined()
    expect(() => sigint?.()).toThrow("exit 0")
    expect(ptyProc.kill).toHaveBeenCalledTimes(1)
    const sigterm = signalHandlers.get("SIGTERM")
    expect(() => sigterm?.()).toThrow("exit 0")
    // stop() is idempotent — the second signal doesn't double-kill.
    expect(ptyProc.kill).toHaveBeenCalledTimes(1)
  })

  it("prints the production home label when KOBE_HOME_DIR is unset", async () => {
    Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
    routeFetch({
      "127.0.0.1:5174/__kobe_web": { body: "kobe-web" },
      "127.0.0.1:5174/": { ok: true },
      "localhost:5176/__kobe_web": new Error("ECONNREFUSED"), // free PTY port → takeover no-ops
    })
    void runWebSubcommand([])
    await vi.waitFor(() => {
      expect(out()).toContain("kobe web → http://localhost:5174")
    })
    expect(out()).toContain(".kobe (production)")
    // Nothing listening on the PTY port → no lsof scan, no kills.
    expect(spawnCalls.filter((c) => c.cmd[0] === "lsof")).toHaveLength(0)
    expect(killSpy).not.toHaveBeenCalled()
  })

  it("refuses to replace a non-kobe service on the PTY port (exit 1)", async () => {
    routeFetch({
      "127.0.0.1:5174/__kobe_web": { body: "kobe-web" },
      "127.0.0.1:5174/": { ok: true },
      "localhost:5176/__kobe_web": { body: "totally-not-kobe" },
    })
    await expect(runWebSubcommand([])).rejects.toThrow("exit 1")
    expect(err()).toContain("PTY port 5176 is in use by a non-kobe service")
  })

  it("--no-takeover never probes the PTY port", async () => {
    routeFetch({
      "127.0.0.1:5174/__kobe_web": { body: "kobe-web" },
      "127.0.0.1:5174/": { ok: true },
    })
    void runWebSubcommand(["--no-takeover"])
    await vi.waitFor(() => {
      expect(out()).toContain("kobe web → http://localhost:5174")
    })
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain("http://localhost:5176/__kobe_web")
  })

  it("fails with exit 1 when the daemon is up but not serving web assets", async () => {
    routeFetch({
      "127.0.0.1:5174/__kobe_web": { body: "kobe-web" },
      "127.0.0.1:5174/": { ok: false },
    })
    await expect(runWebSubcommand([])).rejects.toThrow("exit 1")
    expect(err()).toContain("not serving web assets")
  })

  it("warns (but keeps serving) when the PTY server script is missing from the build", async () => {
    // SPA dist exists, pty-server.mjs does not.
    mocks.existsSync.mockImplementation((p: string) => !p.endsWith("pty-server.mjs"))
    routeFetch({
      "127.0.0.1:5174/__kobe_web": { body: "kobe-web" },
      "127.0.0.1:5174/": { ok: true },
    })
    void runWebSubcommand([])
    await vi.waitFor(() => {
      expect(err()).toContain("PTY server not found; terminal tabs will be unavailable")
    })
    expect(out()).toContain("kobe web → http://localhost:5174")
    expect(spawnCalls.find((c) => c.cmd[0] === "node")).toBeUndefined()
  })

  it("still launches when the lsof port scan itself fails (no pids → nothing to kill)", async () => {
    routeFetch({
      "127.0.0.1:5174/__kobe_web": { body: "kobe-web" },
      "127.0.0.1:5174/": { ok: true },
      "localhost:5176/__kobe_web": { body: "kobe-web" }, // a stale kobe-web answers…
    })
    // …but lsof is unavailable — pidsOnPort degrades to [] instead of crashing.
    const bunSpawn = (globalThis as unknown as { Bun: { spawn: ReturnType<typeof vi.fn> } }).Bun.spawn
    bunSpawn.mockImplementation((cmd: string[], opts?: Record<string, unknown>) => {
      spawnCalls.push({ cmd, opts })
      if (cmd[0] === "lsof") throw new Error("lsof: command not found")
      return ptyProc
    })
    void runWebSubcommand([])
    await vi.waitFor(() => {
      expect(out()).toContain("kobe web → http://localhost:5174")
    })
    expect(killSpy).not.toHaveBeenCalled()
  })

  it("an unexpected PTY sidecar exit tears the command down with exit 1", async () => {
    routeFetch({
      "127.0.0.1:5174/__kobe_web": { body: "kobe-web" },
      "127.0.0.1:5174/": { ok: true },
      "localhost:5176/__kobe_web": new Error("ECONNREFUSED"),
    })
    // The exit-watcher's process.exit(1) runs inside a detached .then — a
    // throwing stub would surface as an unhandled rejection, so record only.
    exitSpy.mockImplementation((() => undefined) as never)
    void runWebSubcommand([])
    await vi.waitFor(() => {
      expect(out()).toContain("kobe web → http://localhost:5174")
    })
    resolvePtyExited(1)
    await vi.waitFor(() => {
      expect(err()).toContain("kobe web: PTY server exited")
    })
    expect(ptyProc.kill).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
