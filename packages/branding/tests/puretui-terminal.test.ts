import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { capturePureTui } from "../scripts/capture-puretui"
import { createSidecarController } from "../scripts/puretui-pty-sidecar.mjs"
import {
  createPureTuiCapture,
  type SidecarFactory,
  type SidecarProcess,
  type SidecarSpawnOptions,
} from "../src/quicklook/puretui-terminal"

type Request = { id: number; op: string; [key: string]: unknown }

class FakeSidecar implements SidecarProcess {
  readonly requests: Request[] = []
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
  readonly exited: Promise<number>
  private output!: ReadableStreamDefaultController<Uint8Array>
  private resolveExit!: (code: number) => void
  private pending = ""
  killCalls = 0

  readonly stdin = {
    write: (chunk: string | Uint8Array) => {
      this.pending += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      for (;;) {
        const newline = this.pending.indexOf("\n")
        if (newline < 0) break
        const line = this.pending.slice(0, newline)
        this.pending = this.pending.slice(newline + 1)
        const request = JSON.parse(line) as Request
        this.requests.push(request)
        this.onRequest(request)
      }
    },
    end: () => {
      if (this.exitOnEnd) this.resolveExit(0)
    },
  }

  constructor(
    private readonly onRequest: (request: Request) => void,
    private readonly exitOnEnd = true,
  ) {
    this.stdout = new ReadableStream({ start: (controller) => (this.output = controller) })
    this.exited = new Promise((resolveExit) => (this.resolveExit = resolveExit))
  }

  respond(response: unknown) {
    this.output.enqueue(new TextEncoder().encode(`${JSON.stringify(response)}\n`))
  }

  exit(code = 0) {
    this.resolveExit(code)
  }

  kill() {
    this.killCalls++
    this.resolveExit(1)
  }
}

const fakeFactory = (handler: (process: FakeSidecar, request: Request) => void) => {
  const calls: SidecarSpawnOptions[] = []
  let process: FakeSidecar
  const factory = ((options: SidecarSpawnOptions) => {
    calls.push(options)
    process = new FakeSidecar((request) => handler(process, request))
    return process
  }) as SidecarFactory & { calls: SidecarSpawnOptions[]; process: () => FakeSidecar }
  factory.calls = calls
  factory.process = () => process
  return factory
}

describe("PureTuiTerminal", () => {
  test("launches dev:sandbox with an isolated home and fixed replay viewport", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..")
    const demoRoot = join(await mkdtemp(join(tmpdir(), "kobe-puretui-test-")), "demo")
    const sidecarFactory = fakeFactory((process, request) => {
      if (request.op === "start") {
        process.respond({ id: request.id, ok: true, value: { pid: 4242, demoRoot, snapshot: "boot" } })
      } else {
        process.respond({ id: request.id, ok: true, value: request.op === "snapshot" ? ["boot"] : null })
      }
    })

    const capture = await createPureTuiCapture({ repoRoot, demoRoot, cols: 160, rows: 45, sidecarFactory })
    expect(sidecarFactory.calls[0]).toMatchObject({
      file: "node",
      args: [expect.stringContaining("puretui-pty-sidecar.mjs")],
      env: expect.objectContaining({
        KOBE_SANDBOX_HOME_DIR: expect.stringContaining(demoRoot),
        KOBE_HOME_DIR: expect.stringContaining(demoRoot),
      }),
    })

    await capture.terminal.start()
    expect(sidecarFactory.process().requests[0]).toMatchObject({
      op: "start",
      repoRoot,
      demoRoot,
      cols: 160,
      rows: 45,
    })
    await capture.cleanup()
  })

  test("protocol timeouts surface the last ANSI snapshot, child pid, and demo root", async () => {
    const demoRoot = join(await mkdtemp(join(tmpdir(), "kobe-puretui-timeout-")), "demo")
    const sidecarFactory = fakeFactory((process, request) => {
      if (request.op === "start") {
        process.respond({
          id: request.id,
          ok: true,
          value: { pid: 90210, demoRoot, snapshot: "\u001b[31mlatest screen\u001b[0m" },
        })
      }
      if (request.op === "stop") process.respond({ id: request.id, ok: true, value: null })
    })
    const capture = await createPureTuiCapture({
      repoRoot: resolve(import.meta.dirname, "../../.."),
      demoRoot,
      cols: 80,
      rows: 24,
      protocolTimeoutMs: 10,
      sidecarFactory,
    })

    await capture.terminal.start()
    await expect(capture.terminal.snapshot()).rejects.toThrow("latest screen")
    await expect(capture.terminal.snapshot()).rejects.toThrow("90210")
    await expect(capture.terminal.snapshot()).rejects.toThrow(demoRoot)
    await capture.cleanup()
  })

  test("terminates a sidecar that stays alive after a failed stop", async () => {
    const demoRoot = join(await mkdtemp(join(tmpdir(), "kobe-puretui-stalled-")), "demo")
    let process: FakeSidecar
    const sidecarFactory = ((options: SidecarSpawnOptions) => {
      void options
      process = new FakeSidecar((request) => {
        if (request.op === "start") {
          process.respond({ id: request.id, ok: true, value: { pid: 55, demoRoot, snapshot: "stalled" } })
        }
        if (request.op === "stop") {
          process.respond({
            id: request.id,
            ok: false,
            error: { message: "child alive", pid: 55, demoRoot, snapshot: "stalled" },
          })
        }
      }, false)
      return process
    }) as SidecarFactory
    const capture = await createPureTuiCapture({
      repoRoot: resolve(import.meta.dirname, "../../.."),
      demoRoot,
      cols: 80,
      rows: 24,
      sidecarExitTimeoutMs: 10,
      sidecarFactory,
    })
    await capture.terminal.start()
    setTimeout(() => process.exit(), 50)

    await expect(capture.cleanup()).rejects.toThrow("child alive")
    expect(process.killCalls).toBe(1)
  }, 200)
})

describe("PureTUI PTY sidecar", () => {
  test("acknowledges stop only after child exit and isolated sandbox reset", async () => {
    const order: string[] = []
    let onExit = () => {}
    const child = {
      pid: 321,
      write: (data: string) => {
        order.push(`write:${JSON.stringify(data)}`)
        queueMicrotask(() => {
          order.push("child-exit")
          onExit()
        })
      },
      kill: () => order.push("kill"),
      onData: () => ({ dispose() {} }),
      onExit: (listener: () => void) => {
        onExit = listener
        return { dispose() {} }
      },
    }
    let launchEnv: Record<string, string> | undefined
    let resetEnv: Record<string, string> | undefined
    const controller = createSidecarController({
      baseEnv: { PATH: process.env.PATH ?? "" },
      spawnPty: (_file: string, _args: string[], options: { env: Record<string, string> }) => {
        launchEnv = options.env
        return child
      },
      createTerminal: () => ({
        write: (_data: string, callback: () => void) => callback(),
        buffer: { active: { getLine: () => undefined } },
        dispose() {},
      }),
      runReset: async (_file: string, _args: string[], options: { env: Record<string, string> }) => {
        resetEnv = options.env
        order.push("reset")
      },
    })
    const demoRoot = join(tmpdir(), "kobe-sidecar-stop")

    expect(
      await controller.handle({ id: 1, op: "start", repoRoot: "/repo", demoRoot, cols: 160, rows: 45 }),
    ).toMatchObject({ ok: true })
    const response = await controller.handle({ id: 2, op: "stop" })
    order.push("ack")

    expect(response).toMatchObject({ id: 2, ok: true })
    expect(order).toEqual(["write:\"\\u0003\"", "child-exit", "reset", "ack"])
    expect(resetEnv).toEqual(launchEnv)
  })

  test("returns diagnostics instead of acknowledging stop while the child remains alive", async () => {
    const controller = createSidecarController({
      baseEnv: { PATH: process.env.PATH ?? "" },
      spawnPty: () => ({
        pid: 777,
        write() {},
        kill() {},
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
      }),
      createTerminal: () => ({
        write: (_data: string, callback: () => void) => callback(),
        buffer: { active: { getLine: () => ({ translateToString: () => "still alive" }) } },
        dispose() {},
      }),
      runReset: async () => {},
      stopTimeoutMs: 1,
      killTimeoutMs: 1,
    })
    const demoRoot = join(tmpdir(), "kobe-sidecar-alive")
    await controller.handle({ id: 1, op: "start", repoRoot: "/repo", demoRoot, cols: 80, rows: 1 })

    const response = await controller.handle({ id: 2, op: "stop" })

    expect(response).toMatchObject({
      id: 2,
      ok: false,
      error: { pid: 777, demoRoot, snapshot: "still alive" },
    })
  })

  test("retains raw ANSI output in sidecar errors", async () => {
    let onData = (_data: string) => {}
    const controller = createSidecarController({
      baseEnv: { PATH: process.env.PATH ?? "" },
      spawnPty: () => ({
        pid: 888,
        write() {},
        kill() {},
        onData: (listener: (data: string) => void) => {
          onData = listener
          return { dispose() {} }
        },
        onExit: () => ({ dispose() {} }),
      }),
      createTerminal: () => ({
        write: (_data: string, callback: () => void) => callback(),
        buffer: { active: { getLine: () => ({ translateToString: () => "rendered" }) } },
        dispose() {},
      }),
    })
    await controller.handle({ id: 1, op: "start", repoRoot: "/repo", demoRoot: "/demo", cols: 80, rows: 1 })
    onData("\u001b[31mraw ansi\u001b[0m")

    const response = await controller.handle({ id: 2, op: "waitFor", pattern: "missing", timeoutMs: 0 })

    expect(response).toMatchObject({ ok: false, error: { snapshot: "\u001b[31mraw ansi\u001b[0m" } })
  })
})

describe("capture PureTUI CLI", () => {
  test("validates the replay spec before spawning the sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "kobe-capture-cli-"))
    const specPath = join(root, "invalid.replay.json")
    await writeFile(specPath, "{}\n")
    let createCalls = 0

    await expect(
      capturePureTui(
        { specPath, outputPath: join(root, "frames.json"), demoRoot: join(root, "demo"), keepDemoRoot: true },
        {
          createCapture: async () => {
            createCalls++
            throw new Error("sidecar must not start")
          },
        },
      ),
    ).rejects.toThrow("replay spec")
    expect(createCalls).toBe(0)
  })
})
