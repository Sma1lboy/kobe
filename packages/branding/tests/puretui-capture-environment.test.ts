import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type CapturePureTuiOptions, capturePureTui } from "../scripts/capture-puretui"
import * as pureTuiTerminal from "../src/quicklook/puretui-terminal"

type CaptureEnvironment = (demoRoot: string) => Record<string, string>

const captureEnvironment = (): CaptureEnvironment | undefined =>
  (pureTuiTerminal as typeof pureTuiTerminal & { captureEnvironment?: CaptureEnvironment }).captureEnvironment

const runZeroCapture = async (claudeCommand?: string): Promise<Record<string, unknown>> => {
  const root = await mkdtemp(join(tmpdir(), "kobe-capture-environment-"))
  const specPath = join(root, "capture.replay.json")
  const outputPath = join(root, "frames.json")
  const demoRoot = join(root, "demo")
  const raw = JSON.parse(
    await Bun.file(join(resolve(import.meta.dirname, ".."), "src/quicklook/quicklook.replay.json")).text(),
  )
  raw.capture.seconds = 0
  raw.beats = []
  raw.stages = [{ name: "still", from: 0, to: "end" }]
  await writeFile(specPath, `${JSON.stringify(raw)}\n`)

  const options: CapturePureTuiOptions & { claudeCommand?: string } = {
    specPath,
    outputPath,
    demoRoot,
    keepDemoRoot: true,
    claudeCommand,
  }
  await capturePureTui(options, {
    createCapture: async (captureOptions) => ({
      demoRoot: captureOptions.demoRoot,
      terminal: {
        async start() {},
        async snapshot() {
          return Array.from({ length: captureOptions.rows }, () => "")
        },
        async type() {},
        async key() {},
        async waitFor() {},
        async stop() {},
      },
      async cleanup() {},
    }),
    log: () => {},
  })
  return Bun.file(join(demoRoot, "home", ".config", "kobe", "state.json")).json()
}

describe("PureTUI capture environment", () => {
  test("does not inherit NO_COLOR into the native replay", () => {
    const buildEnvironment = captureEnvironment()
    expect(typeof buildEnvironment).toBe("function")
    if (!buildEnvironment) return

    const previous = process.env.NO_COLOR
    process.env.NO_COLOR = "1"
    try {
      const env = buildEnvironment("/tmp/kobe-color-capture")
      expect(env).not.toHaveProperty("NO_COLOR")
      expect(env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor" })
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previous
    }
  })

  test("leaves the isolated engine command unset by default", async () => {
    const state = await runZeroCapture()
    expect(state).not.toHaveProperty("engineCommand.claude")
  })

  test("persists a capture-only Claude command override", async () => {
    const command = "/usr/bin/env TEST_CAPTURE=1 claude --model test"
    const state = await runZeroCapture(command)
    expect(state["engineCommand.claude"]).toBe(command)
  })
})
