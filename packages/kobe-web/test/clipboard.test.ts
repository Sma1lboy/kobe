// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { copyText } from "../src/lib/clipboard.ts"

/**
 * copyText backs Copy path / Copy link. The contract: prefer
 * navigator.clipboard.writeText, fall back to a hidden-textarea execCommand
 * when the Clipboard API is missing or rejects (non-secure context / denied),
 * and report true/false so the UI shows a "Copied" ack only on success.
 * Headless browsers block the real clipboard, so this is where the fallback
 * paths are actually exercised.
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("copyText", () => {
  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    expect(await copyText("hello")).toBe(true)
    expect(writeText).toHaveBeenCalledWith("hello")
  })

  it("falls back to execCommand when writeText rejects", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    })
    const exec = vi.fn().mockReturnValue(true)
    document.execCommand = exec
    expect(await copyText("x")).toBe(true)
    expect(exec).toHaveBeenCalledWith("copy")
  })

  it("falls back to execCommand when the Clipboard API is absent", async () => {
    vi.stubGlobal("navigator", {})
    document.execCommand = vi.fn().mockReturnValue(true)
    expect(await copyText("x")).toBe(true)
  })

  it("returns false when both the API and the fallback fail", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error()) },
    })
    document.execCommand = vi.fn().mockReturnValue(false)
    expect(await copyText("x")).toBe(false)
  })

  it("cleans up the temporary textarea it creates for the fallback", async () => {
    vi.stubGlobal("navigator", {})
    document.execCommand = vi.fn().mockReturnValue(true)
    await copyText("x")
    expect(document.querySelectorAll("textarea")).toHaveLength(0)
  })
})
