import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ResolvedReplaySpec } from "../src/quicklook/replay-spec"
import {
  runReplayCapture,
  writeCaptureAtomically,
  type CaptureClock,
  type CaptureDocument,
  type CaptureOutput,
  type CaptureTerminal,
} from "../src/quicklook/capture-core"

class FakeTerminal implements CaptureTerminal {
  readonly calls: string[] = []
  stopCalls = 0
  private snapshotIndex = 0

  constructor(
    private readonly screens: readonly string[],
    private readonly failure?: Error,
  ) {}

  async start() {
    this.calls.push("start")
  }

  async snapshot() {
    const screen = this.screens[Math.min(this.snapshotIndex++, this.screens.length - 1)] ?? ""
    return [screen]
  }

  async type(text: string) {
    this.calls.push(`type:${text}`)
  }

  async key(key: string) {
    this.calls.push(`key:${key}`)
  }

  async waitFor(pattern: string, timeoutMs: number) {
    this.calls.push(`wait:${pattern}:${timeoutMs}`)
    if (this.failure) throw this.failure
  }

  async stop() {
    this.stopCalls++
    this.calls.push("stop")
  }
}

const clock = (times: readonly number[]): CaptureClock & { sleeps: number[] } => {
  let index = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => times[Math.min(index++, times.length - 1)] ?? 0,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
}

const advancingClock = (): CaptureClock & { sleeps: number[] } => {
  let now = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  }
}

const memoryOutput = (): CaptureOutput & { writes: CaptureDocument[] } => ({
  writes: [],
  replaceAtomically: async function (capture) {
    this.writes.push(capture)
  },
})

const spec = (beats: ResolvedReplaySpec["beats"]): ResolvedReplaySpec =>
  ({
    id: "capture-test",
    viewport: { cols: 80, rows: 1, width: 80, height: 1 },
    capture: {
      fps: 10,
      seconds: Math.max(0, ...beats.map((beat) => beat.at)),
      output: "capture.json",
      home: ".home",
      repoDefault: ".",
      shellPrompt: "$ ",
    },
    waits: { composer: { pattern: "composer", timeoutMs: 500 } },
    text: { prompt: "go" },
    beats,
    regions: {},
    stages: [],
    camera: {
      transitionSeconds: 1,
      fit: 1,
      minScale: 1,
      maxScale: 1,
      tailHoldSeconds: 1,
      minChangedCells: 1,
      rowGap: 1,
      colQuantiles: [0, 1],
    },
    theme: { defaultFg: "#fff", defaultBg: "#000", ansi16: Array(16).fill("#000") },
  }) as ResolvedReplaySpec

describe("capture core", () => {
  test("captures only changed screens with elapsed wall-clock timestamps", async () => {
    const result = await runReplayCapture(
      spec([{ at: 0, action: "key", key: "Enter" }, { at: 0.1, action: "sleep", ms: 1 }]),
      new FakeTerminal(["boot", "boot", "dialog"]),
      memoryOutput(),
      clock([100, 140, 225]),
    )

    expect(result.frames.map((frame) => [frame.t, frame.lines])).toEqual([
      [0, ["boot"]],
      [0.125, ["dialog"]],
    ])
    expect(result.meta).toEqual({ theme: spec([]).theme })
  })

  test("polls idle timeline changes at capture fps through capture end", async () => {
    const replay = spec([])
    replay.capture.seconds = 0.3
    const timer = advancingClock()

    const result = await runReplayCapture(
      replay,
      new FakeTerminal(["boot", "working", "working", "done"]),
      memoryOutput(),
      timer,
    )

    expect(timer.sleeps).toEqual([100, 100, 100])
    expect(result.frames.map((frame) => [frame.t, frame.lines])).toEqual([
      [0, ["boot"]],
      [0.1, ["working"]],
      [0.3, ["done"]],
    ])
  })

  test("orders out-of-order beats chronologically while preserving equal-time order", async () => {
    const terminal = new FakeTerminal(["boot"])

    await runReplayCapture(
      spec([
        { at: 2, action: "key", key: "second" },
        { at: 1, action: "key", key: "first" },
        { at: 2, action: "key", key: "third" },
      ]),
      terminal,
      memoryOutput(),
      clock([0]),
    )

    expect(terminal.calls).toEqual(["start", "key:first", "key:second", "key:third", "stop"])
  })

  test("attempts snapshots after declared zero-duration sleeps and settles", async () => {
    const result = await runReplayCapture(
      spec([
        { at: 0, action: "sleep", ms: 0 },
        { at: 0, action: "typeText", text: "g", settleMs: 0 },
      ]),
      new FakeTerminal(["boot", "after-sleep", "after-settle", "after-type"]),
      memoryOutput(),
      clock([0]),
    )

    expect(result.frames.map((frame) => frame.lines)).toEqual([["boot"], ["after-sleep"], ["after-settle"], ["after-type"]])
  })

  test("stops the terminal and leaves the previous output untouched when a beat fails", async () => {
    const terminal = new FakeTerminal(["boot"], new Error("composer timeout"))
    const output = memoryOutput()

    await expect(
      runReplayCapture(spec([{ at: 0, action: "typeTextWhenReady", waitFor: "composer", textRef: "prompt" }]), terminal, output, clock([0])),
    ).rejects.toThrow("composer timeout")

    expect(terminal.stopCalls).toBe(1)
    expect(output.writes).toEqual([])
  })

  test("types one character at a time and waits before submitting", async () => {
    const terminal = new FakeTerminal(["boot"])
    const timer = clock([0])

    await runReplayCapture(
      spec([{ at: 0, action: "typeText", text: "go", msPerChar: 45, submit: true, submitDelayMs: 500 }]),
      terminal,
      memoryOutput(),
      timer,
    )

    expect(terminal.calls).toEqual(["start", "type:g", "type:o", "key:Enter", "stop"])
    expect(timer.sleeps).toEqual([45, 500])
  })

  test("waits for typeTextWhenReady before typing", async () => {
    const terminal = new FakeTerminal(["boot"])

    await runReplayCapture(
      spec([{ at: 0, action: "typeTextWhenReady", waitFor: "composer", textRef: "prompt", settleMs: 10 }]),
      terminal,
      memoryOutput(),
      clock([0]),
    )

    expect(terminal.calls).toEqual(["start", "wait:composer:500", "type:g", "type:o", "stop"])
  })

  test("expands the named createTask flow", async () => {
    const terminal = new FakeTerminal(["boot"])
    const timer = clock([0])
    const replay = spec([{ at: 0, action: "flow", flow: "createTask", engine: "codex" }])
    replay.flows = {
      createTask: {
        focusPaneBeforeOpen: "leftmost",
        openKey: "n",
        dialogWait: "composer",
        dialogSettleMs: 10,
        codexEngineCycleKey: "C-e",
        codexEngineSettleMs: 20,
        tabCount: 2,
        tabDelayMs: 30,
        submitKey: "Enter",
      },
    }

    await runReplayCapture(replay, terminal, memoryOutput(), timer)

    expect(terminal.calls).toEqual([
      "start",
      "key:C-h",
      "key:n",
      "wait:composer:500",
      "key:C-e",
      "key:Tab",
      "key:Tab",
      "key:Enter",
      "stop",
    ])
    expect(timer.sleeps).toEqual([10, 20, 30, 30])
  })

  test("writes through a same-directory temporary file before renaming", async () => {
    const root = await mkdtemp(join(tmpdir(), "kobe-capture-core-"))
    const path = join(root, "frames.json")
    const document: CaptureDocument = { cols: 1, rows: 1, frames: [{ t: 0, lines: ["boot"] }], meta: {} }

    try {
      await writeCaptureAtomically(path, document)
      await expect(readFile(path, "utf8")).resolves.toContain('"cols": 1')
      expect(await readdir(root)).toEqual(["frames.json"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
