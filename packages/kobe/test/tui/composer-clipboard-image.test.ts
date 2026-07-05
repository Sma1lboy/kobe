/**
 * Unit tests for `clipboard-image.ts`. The OS clipboard read shells out to
 * `osascript` on macOS, so the exec seam (`child_process.spawn`) and the
 * post-write `statSync` check are mocked and `process.platform` is overridden
 * — that exercises the real script-building + exit-status logic on any host
 * without a live clipboard.
 */

import { afterEach, describe, expect, test, vi } from "vitest"

// Controls what the mocked spawned process emits.
let emit: { event: "close" | "error"; arg: number | null } = { event: "close", arg: 0 }
let statSize = 10

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    once(event: string, cb: (arg?: unknown) => void) {
      if (event === emit.event) queueMicrotask(() => cb(emit.arg))
    },
  })),
}))
vi.mock("node:fs", () => ({
  statSync: vi.fn(() => ({ size: statSize })),
}))

import { clipboardImageSupported, readClipboardImageToFile } from "../../src/tui/chat/composer/clipboard-image"

const realPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true })
}
afterEach(() => setPlatform(realPlatform))

describe("clipboardImageSupported", () => {
  test("true only on darwin", () => {
    setPlatform("darwin")
    expect(clipboardImageSupported()).toBe(true)
    setPlatform("linux")
    expect(clipboardImageSupported()).toBe(false)
  })
})

describe("readClipboardImageToFile", () => {
  test("returns null immediately off darwin", async () => {
    setPlatform("linux")
    expect(await readClipboardImageToFile("/tmp/x.png")).toBeNull()
  })

  test("darwin: exit 0 + non-empty file → image/png", async () => {
    setPlatform("darwin")
    emit = { event: "close", arg: 0 }
    statSize = 42
    expect(await readClipboardImageToFile("/tmp/x.png")).toEqual({ mimeType: "image/png" })
  })

  test("darwin: exit 0 but zero-byte file → null", async () => {
    setPlatform("darwin")
    emit = { event: "close", arg: 0 }
    statSize = 0
    expect(await readClipboardImageToFile("/tmp/x.png")).toBeNull()
  })

  test("darwin: non-zero exit (no image on clipboard) → null", async () => {
    setPlatform("darwin")
    emit = { event: "close", arg: 1 }
    statSize = 10
    expect(await readClipboardImageToFile("/tmp/x.png")).toBeNull()
  })

  test("darwin: spawn error → null", async () => {
    setPlatform("darwin")
    emit = { event: "error", arg: null }
    expect(await readClipboardImageToFile("/tmp/x.png")).toBeNull()
  })
})
