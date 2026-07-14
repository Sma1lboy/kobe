import { describe, expect, test } from "bun:test"
import quicklookSpec from "../src/quicklook/quicklook.replay.json"
import { regionCoordinateHash, replayDurationSeconds, resolveReplaySpec } from "../src/quicklook/replay-spec"

const capture = {
  cols: 160,
  rows: 45,
  frames: [
    { t: 0, lines: [] },
    { t: 12.5, lines: [] },
  ],
}

const baseSpec = {
  id: "quicklook",
  viewport: { cols: 160, rows: 45, width: 1280, height: 720 },
  capture: {
    fps: 10,
    seconds: 120,
    output: "src/quicklook/frames.json",
    home: ".capture-home",
    repoDefault: "/tmp/kobe",
    shellPrompt: "kobe$ ",
  },
  waits: {
    newTaskDialog: { pattern: "New task", timeoutMs: 8000 },
    composerReady: { pattern: "›", timeoutMs: 30000 },
  },
  text: {
    prompt: "Summarize packages/branding.",
  },
  regions: {
    dialog: { c0: 30, c1: 130, r0: 6, r1: 38, hash: "ai-reviewed-dialog-region" },
  },
  stages: [
    { name: "shell", from: 0, to: 3, region: "full" },
    { name: "dialog", from: 3, to: 8, region: "dialog" },
    { name: "wrap", from: 8, to: "end" },
  ],
  beats: [
    { at: 1, action: "typeText", text: "kobe", msPerChar: 160 },
    { at: 4, action: "typeTextWhenReady", waitFor: "composerReady", textRef: "prompt", msPerChar: 45, submit: true },
  ],
  camera: { transitionSeconds: 1.2, fit: 0.8, minScale: 1, maxScale: 1.6, tailHoldSeconds: 4 },
}

describe("replay spec", () => {
  test("resolves dynamic full region and duration from capture tail", () => {
    const spec = resolveReplaySpec(baseSpec, capture)

    expect(spec.regions.full).toEqual({
      c0: 0,
      c1: 159,
      r0: 0,
      r1: 44,
      hash: regionCoordinateHash("full", { c0: 0, c1: 159, r0: 0, r1: 44 }, capture),
    })
    expect(spec.regions.dialog.hash).toBe("ai-reviewed-dialog-region")
    expect(spec.stages[2]).toEqual({ name: "wrap", from: 8, to: 16.5 })
    expect(replayDurationSeconds(spec, capture)).toBe(16.5)
  })

  test("rejects unknown stage regions and wait references", () => {
    expect(() =>
      resolveReplaySpec(
        {
          ...baseSpec,
          stages: [{ name: "bad", from: 0, to: 1, region: "missing" }],
        },
        capture,
      ),
    ).toThrow(/unknown region "missing"/)

    expect(() =>
      resolveReplaySpec(
        {
          ...baseSpec,
          beats: [{ at: 1, action: "typeTextWhenReady", waitFor: "missing", textRef: "prompt", msPerChar: 45 }],
        },
        capture,
      ),
    ).toThrow(/unknown wait "missing"/)

    expect(() =>
      resolveReplaySpec(
        {
          ...baseSpec,
          regions: { dialog: { c0: 30, c1: 130, r0: 6, r1: 38, hash: 42 } },
        },
        capture,
      ),
    ).toThrow(/regions.dialog.hash/)

    expect(() =>
      resolveReplaySpec(
        {
          ...baseSpec,
          flows: { createTask: { dialogWait: "newTaskDialog", focusPaneBeforeOpen: "rightmost" } },
        },
        capture,
      ),
    ).toThrow(/focusPaneBeforeOpen/)

    expect(() =>
      resolveReplaySpec(
        {
          ...baseSpec,
          theme: { defaultFg: "#fff", defaultBg: "#000", ansi16: ["#000"] },
        },
        capture,
      ),
    ).toThrow(/theme.ansi16/)

    expect(() =>
      resolveReplaySpec(
        {
          ...baseSpec,
          theme: {
            defaultFg: "#fff",
            defaultBg: "#000",
            ansi16: [
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
              "#000",
            ],
            runOverrides: [],
          },
        },
        capture,
      ),
    ).toThrow(/theme.runOverrides/)
  })

  test("rejects unsupported capture actions and missing flow names", () => {
    expect(() => resolveReplaySpec({ ...baseSpec, beats: [{ at: 0, action: "mouse" }] }, capture)).toThrow(
      /unsupported action "mouse"/,
    )
    expect(() =>
      resolveReplaySpec({ ...baseSpec, beats: [{ at: 0, action: "flow", flow: "missing" }] }, capture),
    ).toThrow(/unknown flow "missing"/)
  })

  test("rejects malformed seed tasks before capture starts", () => {
    expect(() =>
      resolveReplaySpec({ ...baseSpec, setup: { seedTasks: [{ title: "", status: "in_progress" }] } }, capture),
    ).toThrow(/setup.seedTasks\[0\].title/)
    expect(() =>
      resolveReplaySpec({ ...baseSpec, setup: { seedTasks: [{ title: "seed", status: "unknown" }] } }, capture),
    ).toThrow(/unsupported status "unknown"/)
  })

  test("rejects capture timing that cannot drive polling", () => {
    expect(() => resolveReplaySpec({ ...baseSpec, capture: { ...baseSpec.capture, fps: 0 } }, capture)).toThrow(
      /capture.fps must be positive/,
    )
  })

  test("rejects an unknown workspace readiness wait", () => {
    expect(() => resolveReplaySpec({ ...baseSpec, setup: { readyWait: "missing" } }, capture)).toThrow(
      /setup references unknown wait "missing"/,
    )
  })

  test("keeps quicklook theme limited to terminal state", () => {
    expect(Object.keys(quicklookSpec.theme).sort()).toEqual(["ansi16", "defaultBg", "defaultFg"])
    expect(quicklookSpec.setup).not.toHaveProperty("fixtureEngines")
    expect(quicklookSpec.waits.claudeComposerReady.pattern).toBe("❯")
  })
})
