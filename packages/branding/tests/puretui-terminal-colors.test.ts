import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { capturePureTui } from "../scripts/capture-puretui"
import * as sidecar from "../scripts/puretui-pty-sidecar.mjs"
import {
  type PureTuiCaptureOptions,
  type SidecarFactory,
  createPureTuiCapture,
} from "../src/quicklook/puretui-terminal"

const createSidecarController = sidecar.createSidecarController
const registerDefaultColorHandlers = (
  sidecar as typeof sidecar & {
    registerDefaultColorHandlers?: (terminal: Terminal, theme: typeof theme, reply: (data: string) => void) => void
  }
).registerDefaultColorHandlers

const theme = { defaultFg: "#FFFFFF", defaultBg: "#141413" }

const writeTerminal = (terminal: Terminal, data: string): Promise<void> =>
  new Promise((resolve) => terminal.write(data, resolve))

const respondingSidecar = () => {
  const requests: Array<Record<string, unknown>> = []
  let output!: ReadableStreamDefaultController<Uint8Array>
  let resolveExit!: (code: number) => void
  let pending = ""
  const exited = new Promise<number>((resolve) => (resolveExit = resolve))
  const factory = (() => ({
    stdin: {
      write(chunk: string | Uint8Array) {
        pending += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
        for (;;) {
          const newline = pending.indexOf("\n")
          if (newline < 0) break
          const request = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>
          pending = pending.slice(newline + 1)
          requests.push(request)
          output.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({ id: request.id, ok: true, value: request.op === "snapshot" ? [] : null })}\n`,
            ),
          )
        }
      },
      end() {
        resolveExit(0)
      },
    },
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => (output = controller) }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited,
    kill() {
      resolveExit(1)
    },
  })) as SidecarFactory
  return { factory, requests }
}

describe("PureTUI terminal color protocol", () => {
  test("answers OSC 10 and OSC 11 queries with the declared replay theme", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const replies: string[] = []
    registerDefaultColorHandlers?.(terminal, theme, (data) => replies.push(data))

    await writeTerminal(terminal, "\x1b]10;?\x07\x1b]11;?\x07")

    expect(replies).toEqual([
      "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
      "\x1b]11;rgb:1414/1414/1313\x1b\\",
    ])
    terminal.dispose()
  })

  test("leaves non-query OSC color operations to xterm", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const replies: string[] = []
    registerDefaultColorHandlers?.(terminal, theme, (data) => replies.push(data))

    await writeTerminal(terminal, "\x1b]10;rgb:aaaa/bbbb/cccc\x07\x1b]11;#010203\x07")

    expect(replies).toEqual([])
    terminal.dispose()
  })

  test("forwards xterm query replies to the live capture child", async () => {
    let emitChildData = (_data: string) => {}
    const childWrites: string[] = []
    const child = {
      pid: 42,
      write: (data: string) => childWrites.push(data),
      kill() {},
      onData: (listener: (data: string) => void) => {
        emitChildData = listener
        return { dispose() {} }
      },
      onExit: () => ({ dispose() {} }),
    }
    const controller = createSidecarController({
      baseEnv: { PATH: process.env.PATH ?? "" },
      spawnPty: () => child,
      createTerminal: (options: { cols: number; rows: number }) =>
        new Terminal({ ...options, allowProposedApi: true, scrollback: 0 }),
    })

    expect(
      await controller.handle({
        id: 1,
        op: "start",
        repoRoot: "/repo",
        demoRoot: "/demo",
        fixtureRepo: "/demo/fixture-repo",
        cols: 80,
        rows: 24,
        theme,
      }),
    ).toMatchObject({ ok: true })

    emitChildData("\x1b[6n")
    await controller.handle({ id: 2, op: "snapshot" })

    expect(childWrites).toEqual(["\x1b[1;1R"])
  })

  test("passes the validated replay theme into capture creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "kobe-replay-colors-"))
    const specPath = join(root, "capture.replay.json")
    const raw = JSON.parse(
      await Bun.file(resolve(import.meta.dirname, "../src/quicklook/quicklook.replay.json")).text(),
    )
    raw.capture.seconds = 0
    raw.beats = []
    raw.stages = [{ name: "still", from: 0, to: "end" }]
    await writeFile(specPath, `${JSON.stringify(raw)}\n`)
    let received: PureTuiCaptureOptions | undefined

    await capturePureTui(
      {
        specPath,
        outputPath: join(root, "frames.json"),
        demoRoot: join(root, "demo"),
        keepDemoRoot: true,
      },
      {
        createCapture: async (options) => {
          received = options
          return {
            demoRoot: options.demoRoot,
            terminal: {
              async start() {},
              async snapshot() {
                return Array.from({ length: options.rows }, () => "")
              },
              async type() {},
              async key() {},
              async waitFor() {},
              async stop() {},
            },
            async cleanup() {},
          }
        },
        log: () => {},
      },
    )

    expect(received?.theme).toEqual(theme)
  })

  test("includes the terminal theme in the sidecar start request", async () => {
    const protocol = respondingSidecar()
    const capture = await createPureTuiCapture({
      repoRoot: resolve(import.meta.dirname, "../../.."),
      demoRoot: join(await mkdtemp(join(tmpdir(), "kobe-sidecar-colors-")), "demo"),
      fixtureRepo: "/fixture",
      cols: 80,
      rows: 24,
      theme,
      sidecarFactory: protocol.factory,
    } as PureTuiCaptureOptions)

    await capture.terminal.start()

    expect(protocol.requests[0]).toMatchObject({ op: "start", theme })
    await capture.cleanup()
  })
})
