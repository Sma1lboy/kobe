import type { NodePtyChild, NodePtySpawn, PtySpawnRequest } from "@sma1lboy/kobe-daemon/daemon/pty-driver"
import { nodePtyDriver } from "@sma1lboy/kobe-daemon/daemon/pty-driver"
import { describe, expect, test } from "vitest"

/**
 * The node-pty translation, unit-tested with the native binding injected out.
 *
 * node-pty ships no Linux prebuild, so a test that spawned a real ConPTY child
 * would only ever run where the module happened to build. Everything worth
 * asserting here is the translation anyway: which spawn options are passed,
 * how the events wire up, and when the exit promise settles.
 */
function fakeNodePty() {
  const calls: string[] = []
  let onData: (data: string) => void = () => {}
  let onExit: (event: { exitCode: number }) => void = () => {}
  let spawnArgs: { file: string; args: readonly string[]; options: Record<string, unknown> } | null = null

  const child: NodePtyChild = {
    pid: 31337,
    onData: (listener) => {
      onData = listener
      return undefined
    },
    onExit: (listener) => {
      onExit = listener
      return undefined
    },
    write: (data) => calls.push(`write:${data}`),
    resize: (cols, rows) => calls.push(`resize:${cols}x${rows}`),
    kill: () => calls.push("kill"),
  }
  const spawn: NodePtySpawn = (file, args, options) => {
    spawnArgs = { file, args, options: options as unknown as Record<string, unknown> }
    return child
  }
  return {
    spawn,
    calls,
    emitData: (data: string) => onData(data),
    emitExit: (exitCode: number) => onExit({ exitCode }),
    get spawnArgs() {
      return spawnArgs
    },
  }
}

const request = (over: Partial<PtySpawnRequest> = {}): PtySpawnRequest => ({
  argv: ["C:\\Program Files\\Git\\bin\\bash.exe", "-ilc", "claude"],
  cwd: "C:\\wt\\task-1",
  env: { TERM: "xterm-256color", KOBE_TASK_ID: "t1" },
  cols: 100,
  rows: 30,
  onData: () => {},
  ...over,
})

describe("nodePtyDriver", () => {
  test("splits argv into node-pty's file + args and forwards the geometry", async () => {
    const pty = fakeNodePty()
    const driver = await nodePtyDriver(pty.spawn)
    driver(request())

    expect(pty.spawnArgs?.file).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
    expect(pty.spawnArgs?.args).toEqual(["-ilc", "claude"])
    expect(pty.spawnArgs?.options).toMatchObject({
      cwd: "C:\\wt\\task-1",
      cols: 100,
      rows: 30,
      name: "xterm-256color",
    })
  })

  test("passes cwd as a NATIVE path, not the shell's posix form", async () => {
    const pty = fakeNodePty()
    const driver = await nodePtyDriver(pty.spawn)
    driver(request())
    // toPosixPath is for values interpolated INTO the script; CreateProcess
    // needs the Windows path. Converting here would break every spawn.
    expect(pty.spawnArgs?.options.cwd).toBe("C:\\wt\\task-1")
  })

  test("drops undefined env entries — node-pty's env takes strings only", async () => {
    const pty = fakeNodePty()
    const driver = await nodePtyDriver(pty.spawn)
    driver(request({ env: { KEEP: "yes", DROPPED: undefined, ALSO_KEPT: "" } }))

    const env = pty.spawnArgs?.options.env as Record<string, string>
    expect(env).toEqual({ KEEP: "yes", ALSO_KEPT: "" })
    expect("DROPPED" in env).toBe(false)
  })

  test("streams child output to the request's onData", async () => {
    const pty = fakeNodePty()
    const driver = await nodePtyDriver(pty.spawn)
    const seen: string[] = []
    driver(request({ onData: (data) => seen.push(String(data)) }))

    pty.emitData("hello ")
    pty.emitData("world")
    expect(seen).toEqual(["hello ", "world"])
  })

  test("exposes the child's pid and settles exited from onExit", async () => {
    const pty = fakeNodePty()
    const driver = await nodePtyDriver(pty.spawn)
    const proc = driver(request())
    expect(proc.pid).toBe(31337)

    let settled: unknown = "pending"
    void proc.exited.then((code) => {
      settled = code
    })
    await Promise.resolve()
    expect(settled).toBe("pending")

    pty.emitExit(3)
    await proc.exited
    expect(settled).toBe(3)
  })

  test("forwards write and resize, and collapses every kill onto node-pty's", async () => {
    const pty = fakeNodePty()
    const driver = await nodePtyDriver(pty.spawn)
    const proc = driver(request())

    proc.write("ls\r")
    proc.resize(120, 40)
    // ConPTY has no signals: SIGTERM and SIGKILL must reach the same call, or
    // the host's escalation would look like it had two distinct steps.
    proc.kill("SIGTERM")
    proc.kill("SIGKILL")
    expect(pty.calls).toEqual(["write:ls\r", "resize:120x40", "kill", "kill"])
  })

  test("close() is a no-op — killing is what releases a node-pty handle", async () => {
    const pty = fakeNodePty()
    const driver = await nodePtyDriver(pty.spawn)
    const proc = driver(request())

    expect(() => proc.close()).not.toThrow()
    expect(() => proc.close()).not.toThrow()
    expect(pty.calls).toEqual([])
  })
})
