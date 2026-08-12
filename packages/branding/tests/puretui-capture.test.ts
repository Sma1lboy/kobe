import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { defaultDaemonSocketPath, defaultPtyHostSocketPath } from "../../kobe-daemon/src/daemon/paths"
import { CAPTURE_SKILL_HINT_VERSION, capturePureTui } from "../scripts/capture-puretui"
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
    // Dialog-only label: "New task" also matches the sidebar's own button,
    // so it would pass before the dialog ever opened.
    spec.waits = { newTaskDialog: { pattern: "from branch", timeoutMs: 8000 } }
    spec.text = { prompt: "Brand Studio replay prompt" }
    spec.flows = {
      createTask: {
        focusPaneBeforeOpen: "leftmost",
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

describe("capture PureTUI CLI", () => {
  test("passes the fixture repo and declared seed tasks to the capture terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "kobe-capture-cli-valid-"))
    const specPath = join(root, "capture.replay.json")
    const outputPath = join(root, "frames.json")
    const raw = JSON.parse(
      await Bun.file(join(resolve(import.meta.dirname, ".."), "src/quicklook/quicklook.replay.json")).text(),
    )
    raw.capture.seconds = 0
    raw.beats = []
    raw.stages = [{ name: "still", from: 0, to: "end" }]
    await writeFile(specPath, `${JSON.stringify(raw)}\n`)
    let received: Parameters<NonNullable<Parameters<typeof capturePureTui>[1]["createCapture"]>>[0] | undefined

    await capturePureTui(
      { specPath, outputPath, demoRoot: join(root, "demo"), keepDemoRoot: true },
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

    expect(received).toMatchObject({
      fixtureRepo: join(root, "demo", "fixture-repo"),
      seedTasks: [{ title: "fix flaky retry test", status: "in_progress" }],
    })
    expect(received).not.toHaveProperty("pathPrefix")
    expect(await Bun.file(join(root, "demo", "home", ".config", "kobe", "state.json")).json()).toEqual({
      onboarded: true,
      skillHintSeen: "1",
      [`skillHintSeen:v${CAPTURE_SKILL_HINT_VERSION}`]: "1",
      savedRepos: [join(root, "demo", "fixture-repo")],
    })
  })

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
