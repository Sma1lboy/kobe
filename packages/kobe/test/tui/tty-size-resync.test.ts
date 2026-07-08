import { describe, expect, test } from "vitest"
import { parseSttySize, syncRendererToTtySize } from "../../src/tui/lib/host-render-options"

describe("TTY size resync", () => {
  test("parses stty size output as columns x rows", () => {
    expect(parseSttySize("65 220\n")).toEqual({ width: 220, height: 65 })
    expect(parseSttySize("not a size")).toBeNull()
    expect(parseSttySize("0 220")).toBeNull()
  })

  test("resizes the renderer when the controlling TTY reports a different size", async () => {
    const calls: Array<[number, number]> = []
    const renderer = {
      terminalWidth: 120,
      terminalHeight: 32,
      resize: (width: number, height: number) => calls.push([width, height]),
    }

    await expect(syncRendererToTtySize(renderer, async () => ({ width: 220, height: 65 }))).resolves.toBe(true)
    expect(calls).toEqual([[220, 65]])
  })

  test("does not resize when the dimensions already match", async () => {
    const calls: Array<[number, number]> = []
    const renderer = {
      terminalWidth: 220,
      terminalHeight: 65,
      resize: (width: number, height: number) => calls.push([width, height]),
    }

    await expect(syncRendererToTtySize(renderer, async () => ({ width: 220, height: 65 }))).resolves.toBe(false)
    expect(calls).toEqual([])
  })
})
