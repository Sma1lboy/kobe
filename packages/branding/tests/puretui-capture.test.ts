import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { defaultDaemonSocketPath, defaultPtyHostSocketPath } from "../../kobe-daemon/src/daemon/paths"
import { capturePureTui } from "../scripts/capture-puretui"
import quicklookSpec from "../src/quicklook/quicklook.replay.json"
import { type RawReplaySpec, assertRenderableCapture } from "../src/quicklook/replay-spec"

test("rejects empty and malformed captures before renderer setup", () => {
  expect(() => assertRenderableCapture({ cols: 160, rows: 45, frames: [] })).toThrow(/at least one frame/)
  expect(() => assertRenderableCapture({ cols: 160, rows: 2, frames: [{ t: 0, lines: ["only one"] }] })).toThrow(
    /line count/,
  )
})

const e2e = process.env.KOBE_REPLAY_E2E === "1" ? test : test.skip

e2e(
  "captures the real PureTUI create-task flow with a test-injected engine",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kobe-puretui-e2e-"))
    const demoRoot = join(root, "demo")
    const outputPath = join(root, "frames.json")
    const specPath = join(root, "capture.replay.json")
    const spec = structuredClone(quicklookSpec) as unknown as RawReplaySpec
    spec.viewport = { cols: 100, rows: 30, width: 800, height: 480 }
    spec.capture.seconds = 18
    spec.setup = { seedTasks: [] }
    spec.waits = { newTaskDialog: { pattern: "New task", timeoutMs: 8000 } }
    spec.text = { prompt: "Brand Studio replay prompt" }
    spec.flows = {
      createTask: {
        openKey: "n",
        dialogWait: "newTaskDialog",
        dialogSettleMs: 100,
        tabCount: 4,
        tabDelayMs: 50,
        submitKey: "Enter",
      },
    }
    spec.beats = [
      { at: 2, action: "flow", flow: "createTask", engine: "claude" },
      { at: 14, action: "typeText", textRef: "prompt", msPerChar: 25 },
      { at: 18, action: "sleep", ms: 0 },
    ]
    spec.regions = {}
    spec.stages = [{ name: "capture", from: 0, to: "end" }]
    await writeFile(specPath, `${JSON.stringify(spec)}\n`)

    const previousPath = process.env.PATH
    process.env.PATH = `${resolve(import.meta.dirname, "../scripts/fixtures")}:${previousPath ?? ""}`
    try {
      await capturePureTui({ specPath, outputPath, demoRoot, keepDemoRoot: true, timeoutMs: 20_000 }, { log: () => {} })
    } finally {
      process.env.PATH = previousPath
    }

    const capture = await Bun.file(outputPath).json()
    const screen = capture.frames.flatMap((frame: { lines: string[] }) => frame.lines).join("\n")
    expect(screen).toContain("New task")
    expect(screen).toContain("Brand Studio replay prompt")
    expect(await Bun.file(defaultDaemonSocketPath(join(demoRoot, "home"))).exists()).toBe(false)
    expect(await Bun.file(defaultPtyHostSocketPath(join(demoRoot, "home"))).exists()).toBe(false)
  },
  45_000,
)
