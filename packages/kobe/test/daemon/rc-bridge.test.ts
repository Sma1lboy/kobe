import type { ChildProcessByStdio } from "node:child_process"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { type RcBridgeStatus, createRcBridge } from "../../src/daemon/rc-bridge.ts"

/**
 * Fake `claude remote-control` child process. Mimics just enough of
 * `ChildProcessByStdio` for RcBridge to drive it: stdout / stderr as
 * Readables it can `.on("data", ...)`, an EventEmitter for exit /
 * error, and a `.kill()` that emits `exit` synchronously.
 *
 * The `onReady` callback fires INSIDE the spawner body — by the time
 * RcBridge attaches its `data` / `exit` listeners. Tests use it to
 * push canned stdout (env id banner, errors) so listeners are
 * guaranteed to receive the events.
 */
type FakeChild = EventEmitter & {
  stdout: Readable
  stderr: Readable
  pid: number
  kill: (sig?: NodeJS.Signals | number) => boolean
}

function makeFakeBridge(opts: {
  onReady: (child: FakeChild) => void
  readyTimeoutMs?: number
  stopGraceMs?: number
}) {
  let child: FakeChild | null = null
  const bridge = createRcBridge({
    binaryPathResolver: async () => "/fake/claude",
    readyTimeoutMs: opts.readyTimeoutMs ?? 500,
    stopGraceMs: opts.stopGraceMs,
    spawner: () => {
      const ee = new EventEmitter() as FakeChild
      ee.stdout = new Readable({ read() {} })
      ee.stderr = new Readable({ read() {} })
      ee.pid = 12345
      ee.kill = (sig?: NodeJS.Signals | number) => {
        setImmediate(() => ee.emit("exit", sig === "SIGKILL" ? 137 : 0, sig ?? null))
        return true
      }
      child = ee
      // Defer the test's stdout pushes one tick so RcBridge has
      // finished attaching its `on("data", ...)` listener.
      setImmediate(() => opts.onReady(ee))
      // FakeChild only implements the surface RcBridge actually uses
      // (stdout / stderr / pid / kill / EventEmitter). Cast through
      // unknown so the strict ChildProcessByStdio shape doesn't force
      // the test to stub stdin / killed / connected / etc.
      return ee as unknown as ChildProcessByStdio<null, Readable, Readable>
    },
  })
  return { bridge, child: () => child }
}

describe("rc-bridge", () => {
  it("transitions off → starting → running once Environment ID arrives", async () => {
    const transitions: RcBridgeStatus[] = []
    const { bridge } = makeFakeBridge({
      onReady: (c) => {
        c.stdout.push("Remote Control v2.1.114\n")
        c.stdout.push("Environment ID: env_TEST123\n")
        c.stdout.push("Continue coding in the Claude app or https://claude.ai/code?environment=env_TEST123\n")
      },
    })
    bridge.onChange((s) => transitions.push(s))
    const ready = await bridge.start({ cwd: "/tmp/fake" })
    expect(ready.state).toBe("running")
    expect(ready.envId).toBe("env_TEST123")
    expect(ready.deeplink).toBe("https://claude.ai/code?environment=env_TEST123")
    expect(transitions.some((s) => s.state === "starting")).toBe(true)
    expect(transitions.at(-1)?.state).toBe("running")
  })

  it("strips ANSI escape sequences before matching the env id", async () => {
    const { bridge } = makeFakeBridge({
      onReady: (c) => {
        c.stdout.push("\x1b[2KEnvironment ID:\x1b[0m env_AnSi42\n")
      },
    })
    const ready = await bridge.start({ cwd: "/tmp/fake" })
    expect(ready.envId).toBe("env_AnSi42")
  })

  it("surfaces stderr tail as the error message when the bridge dies before becoming ready", async () => {
    const { bridge } = makeFakeBridge({
      onReady: (c) => {
        c.stderr.push("Error: Workspace not trusted. Please run `claude` first.\n")
        setImmediate(() => c.emit("exit", 1, null))
      },
    })
    await expect(bridge.start({ cwd: "/tmp/fake" })).rejects.toThrow(/Workspace not trusted/)
    expect(bridge.status().state).toBe("error")
    expect(bridge.status().errorMessage).toContain("Workspace not trusted")
  })

  it("stop() SIGTERMs the child and transitions to off cleanly", async () => {
    const { bridge } = makeFakeBridge({
      onReady: (c) => {
        c.stdout.push("Environment ID: env_TEST_STOP\n")
      },
    })
    await bridge.start({ cwd: "/tmp/fake" })
    expect(bridge.status().state).toBe("running")
    const stopped = await bridge.stop()
    expect(stopped.state).toBe("off")
  })

  it("rejects with a timeout error when the child never prints the env id", async () => {
    const { bridge } = makeFakeBridge({
      onReady: () => {
        // intentionally silent — the timeout should fire
      },
      readyTimeoutMs: 25,
    })
    await expect(bridge.start({ cwd: "/tmp/fake" })).rejects.toThrow(/timed out|did not become ready/)
    expect(bridge.status().state).toBe("error")
  })
})
