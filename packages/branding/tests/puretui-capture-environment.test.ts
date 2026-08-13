import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type CapturePureTuiOptions, capturePureTui } from "../scripts/capture-puretui"
import { isEngineSessionMarker } from "../src/quicklook/puretui-terminal"
import * as pureTuiTerminal from "../src/quicklook/puretui-terminal"

type CaptureEnvironment = (demoRoot: string, shellPrompt?: string) => Record<string, string>

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

  test("pins the shell prompt so shell beats stay waitable off-macOS", () => {
    const buildEnvironment = captureEnvironment()
    expect(typeof buildEnvironment).toBe("function")
    if (!buildEnvironment) return

    // Without the pin the prompt is whatever the operator's login shell
    // paints — bare `$` under dash — and every shellPrompt wait times out.
    expect(buildEnvironment("/tmp/kobe-prompt-capture", "kobe-demo$ ")).toMatchObject({
      SHELL: "/bin/sh",
      PS1: "kobe-demo$ ",
    })
  })

  test("leaves the shell prompt alone when the spec pins none", () => {
    const buildEnvironment = captureEnvironment()
    if (!buildEnvironment) return
    const env = buildEnvironment("/tmp/kobe-prompt-capture")
    expect(env).not.toHaveProperty("PS1")
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

describe("engine session markers", () => {
  test("scrubs the markers an outer engine session sets for its children", () => {
    // Captured from inside Claude Code, these would make the recorded engine
    // believe it is a nested child and paint a transcript-off warning.
    for (const key of [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_PID",
      "CLAUDE_EFFORT",
    ]) {
      expect(isEngineSessionMarker(key)).toBe(true)
    }
  })

  test("keeps CLAUDE_CONFIG_DIR, which kobe reads for history and the quota line", () => {
    expect(isEngineSessionMarker("CLAUDE_CONFIG_DIR")).toBe(false)
    expect(isEngineSessionMarker("PATH")).toBe(false)
  })
})
