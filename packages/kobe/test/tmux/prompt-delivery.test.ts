import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const capturePaneById = vi.fn<(paneId: string, lines?: number) => Promise<string>>()
const claudePaneId = vi.fn<(session: string) => Promise<string>>()
const claudePaneIdStrict = vi.fn<(session: string) => Promise<string>>()
const runTmux = vi.fn<(args: string[]) => Promise<number>>()
const sendKeyName = vi.fn<(target: string, key: string) => Promise<void>>()

vi.mock("../../src/tmux/client.ts", () => ({
  capturePaneById: (...a: [string, number?]) => capturePaneById(...a),
  claudePaneId: (...a: [string]) => claudePaneId(...a),
  claudePaneIdStrict: (...a: [string]) => claudePaneIdStrict(...a),
  runTmux: (...a: [string[]]) => runTmux(...a),
  sendKeyName: (...a: [string, string]) => sendKeyName(...a),
}))

import { deliverFirstEngineMessage, pasteAndSubmit, waitForEnginePane } from "../../src/tmux/prompt-delivery.ts"

beforeEach(() => {
  vi.useFakeTimers()
  capturePaneById.mockReset().mockResolvedValue("")
  claudePaneId.mockReset().mockResolvedValue("")
  claudePaneIdStrict.mockReset().mockResolvedValue("")
  runTmux.mockReset().mockResolvedValue(0)
  sendKeyName.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("waitForEnginePane", () => {
  it("returns immediately (ready) for a non-fresh session whose pane exists", async () => {
    claudePaneIdStrict.mockResolvedValue("%7")
    await expect(waitForEnginePane("kobe-x", false)).resolves.toEqual({ pane: "%7", ready: true })
    expect(capturePaneById).not.toHaveBeenCalled()
  })

  it("for a fresh session, waits until two consecutive captures are identical and non-empty", async () => {
    claudePaneIdStrict.mockResolvedValue("%3")
    capturePaneById.mockResolvedValueOnce("booting…").mockResolvedValueOnce("prompt >").mockResolvedValue("prompt >")
    const p = waitForEnginePane("kobe-x", true)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toEqual({ pane: "%3", ready: true })
    expect(capturePaneById).toHaveBeenCalledTimes(3)
  })

  it("an all-empty screen never reads as stable — the budget runs out instead", async () => {
    claudePaneIdStrict.mockResolvedValue("%3")
    capturePaneById.mockResolvedValue("   ")
    const p = waitForEnginePane("kobe-x", true)
    await vi.advanceTimersByTimeAsync(24 * 250 + 50)
    await expect(p).resolves.toEqual({ pane: "%3", ready: false })
  })

  it("budget exhausted with no tagged pane: falls back to claudePaneId and reports ready=false", async () => {
    claudePaneIdStrict.mockResolvedValue("")
    claudePaneId.mockResolvedValue("%legacy")
    const p = waitForEnginePane("kobe-x", true)
    await vi.advanceTimersByTimeAsync(24 * 250 + 50)
    await expect(p).resolves.toEqual({ pane: "%legacy", ready: false })
    expect(claudePaneIdStrict).toHaveBeenCalledTimes(25)
  })
})

describe("pasteAndSubmit", () => {
  it("sets + pastes a bracketed buffer, then submits Enter as a separate delayed read", async () => {
    const p = pasteAndSubmit("%9", "line one\n\nline two")
    await vi.advanceTimersByTimeAsync(149)
    expect(runTmux).toHaveBeenCalledTimes(2)
    expect(sendKeyName).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(runTmux.mock.calls[0]?.[0]).toEqual(["set-buffer", "-b", "kobe-api-9", "--", "line one\n\nline two"])
    expect(runTmux.mock.calls[1]?.[0]).toEqual(["paste-buffer", "-p", "-d", "-b", "kobe-api-9", "-t", "%9"])
    expect(sendKeyName).toHaveBeenCalledWith("%9", "Enter")
  })
})

describe("deliverFirstEngineMessage", () => {
  it("delivers the message once the pane is ready", async () => {
    claudePaneIdStrict.mockResolvedValue("%2")
    capturePaneById.mockResolvedValue("stable prompt")
    const p = deliverFirstEngineMessage("kobe-x", { text: "hello", source: "repo-init" })
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(runTmux).toHaveBeenCalledWith(["set-buffer", "-b", "kobe-api-2", "--", "hello"])
    expect(sendKeyName).toHaveBeenCalledWith("%2", "Enter")
  })

  it("is a no-op when no pane can be found (user can still type)", async () => {
    claudePaneIdStrict.mockResolvedValue("")
    claudePaneId.mockResolvedValue("")
    const p = deliverFirstEngineMessage("kobe-x", { text: "hello", source: "repo-init" })
    await vi.advanceTimersByTimeAsync(24 * 250 + 50)
    await p
    expect(runTmux).not.toHaveBeenCalled()
    expect(sendKeyName).not.toHaveBeenCalled()
  })
})
