import type {
  BunTerminalProc,
  BunTerminalSpawn,
  NodePtyChild,
  NodePtySpawn,
  PtySpawnRequest,
} from "@sma1lboy/kobe-daemon/daemon/pty-driver"
import { bunTerminalDriver, nodePtyDriver } from "@sma1lboy/kobe-daemon/daemon/pty-driver"
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
    void proc.exited.then((exit) => {
      settled = exit
    })
    await Promise.resolve()
    expect(settled).toBe("pending")

    pty.emitExit(3)
    await proc.exited
    expect(settled).toEqual({ code: 3, signal: null })
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

/** The driver every macOS and Linux user runs — `Bun` is not a global here. */
function fakeBunTerminal(withHandle = true) {
  const calls: string[] = []
  let emit: (data: Uint8Array) => void = () => {}
  let spawnArgs: { argv: string[]; options: Record<string, unknown> } | null = null
  let settleExit: (code: number | null, signal?: string | null) => void = () => {}

  // Mutable like Bun's Subprocess: exitCode/signalCode are set at exit time.
  const proc: BunTerminalProc & { exitCode: number | null; signalCode: string | null } = {
    pid: 777,
    exitCode: null,
    signalCode: null,
    exited: new Promise<number | null>((resolve) => {
      settleExit = (code, signal) => {
        proc.exitCode = code
        proc.signalCode = signal ?? null
        resolve(code)
      }
    }),
    terminal: withHandle
      ? {
          write: (data) => calls.push(`write:${data}`),
          resize: (cols, rows) => calls.push(`resize:${cols}x${rows}`),
          close: () => calls.push("close"),
        }
      : undefined,
    kill: (signal) => calls.push(`kill:${signal}`),
  }
  const spawn: BunTerminalSpawn = (argv, options) => {
    spawnArgs = { argv, options: options as unknown as Record<string, unknown> }
    emit = options.terminal.data.bind(null, null) as (data: Uint8Array) => void
    return proc
  }
  return {
    spawn,
    calls,
    emitData: (text: string) => emit(new TextEncoder().encode(text)),
    settleExit,
    get spawnArgs() {
      return spawnArgs
    },
  }
}

describe("bunTerminalDriver", () => {
  test("passes argv as a copy, with cwd, env and the terminal geometry", () => {
    const bun = fakeBunTerminal()
    const argv = ["/bin/zsh", "-ilc", "claude"]
    bunTerminalDriver(bun.spawn)(request({ argv, cwd: "/wt/task-1", env: { TERM: "xterm-256color" } }))

    expect(bun.spawnArgs?.argv).toEqual(argv)
    // A copy, not the caller's array — the spec's argv is readonly.
    expect(bun.spawnArgs?.argv).not.toBe(argv)
    expect(bun.spawnArgs?.options).toMatchObject({ cwd: "/wt/task-1", env: { TERM: "xterm-256color" } })
    expect(bun.spawnArgs?.options.terminal).toMatchObject({ cols: 100, rows: 30, name: "xterm-256color" })
  })

  test("keeps undefined env entries — unlike node-pty, Bun accepts them", () => {
    const bun = fakeBunTerminal()
    bunTerminalDriver(bun.spawn)(request({ env: { KEEP: "yes", UNSET: undefined } }))
    expect(bun.spawnArgs?.options.env).toEqual({ KEEP: "yes", UNSET: undefined })
  })

  test("routes Bun's (terminal, data) callback to the request's onData", () => {
    const bun = fakeBunTerminal()
    const seen: string[] = []
    bunTerminalDriver(bun.spawn)(request({ onData: (d) => seen.push(Buffer.from(d as Uint8Array).toString()) }))

    bun.emitData("chunk-1")
    expect(seen).toEqual(["chunk-1"])
  })

  test("forwards io to the terminal handle and the signal to the proc", () => {
    const bun = fakeBunTerminal()
    const proc = bunTerminalDriver(bun.spawn)(request())

    proc.write("ls\r")
    proc.resize(120, 40)
    proc.close()
    // Bun DOES distinguish the signals, so they must arrive as sent.
    proc.kill("SIGTERM")
    proc.kill("SIGKILL")
    expect(bun.calls).toEqual(["write:ls\r", "resize:120x40", "close", "kill:SIGTERM", "kill:SIGKILL"])
  })

  test("tolerates a terminal handle that is already gone", () => {
    // Bun drops it once the child exits; a detaching client's last write must
    // not throw past the host and take the session's cleanup with it.
    const bun = fakeBunTerminal(false)
    const proc = bunTerminalDriver(bun.spawn)(request())

    expect(() => proc.write("late")).not.toThrow()
    expect(() => proc.resize(80, 24)).not.toThrow()
    expect(() => proc.close()).not.toThrow()
    expect(bun.calls).toEqual([])
  })

  test("exposes the pid and settles exited with the proc's exit code", async () => {
    const bun = fakeBunTerminal()
    const proc = bunTerminalDriver(bun.spawn)(request())
    expect(proc.pid).toBe(777)

    bun.settleExit(3)
    // The death cause used to be discarded here (issue #9) — the driver now
    // reads Bun's exitCode/signalCode after settle instead of dropping them.
    await expect(proc.exited).resolves.toEqual({ code: 3, signal: null })
  })

  test("a signal-killed child reports its signal, not a bare null code", async () => {
    const bun = fakeBunTerminal()
    const proc = bunTerminalDriver(bun.spawn)(request())

    bun.settleExit(null, "SIGKILL")
    await expect(proc.exited).resolves.toEqual({ code: null, signal: "SIGKILL" })
  })
})
