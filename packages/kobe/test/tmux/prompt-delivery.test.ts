/**
 * Unit tests for `src/tmux/prompt-delivery.ts` — the shared readiness-wait
 * + bracketed-paste delivery used by `kobe api send`, `spawn-task`, and the
 * per-repo init prompt.
 *
 * Why these matter: this is the only path that turns a scripted prompt into
 * keystrokes inside an engine pane. Regressions here are silent — the prompt
 * lands mid-boot, or the submit Enter coalesces into the paste and the text
 * sits unsent in the composer (CHANGELOG 8f6dd64). The tmux client is mocked
 * (no live tmux server in CI) and the wait loop runs on fake timers.
 */

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
    // A non-fresh session never needs the paint-stability probe.
    expect(capturePaneById).not.toHaveBeenCalled()
  })

  it("for a fresh session, waits until two consecutive captures are identical and non-empty", async () => {
    claudePaneIdStrict.mockResolvedValue("%3")
    capturePaneById
      .mockResolvedValueOnce("booting…") // first paint
      .mockResolvedValueOnce("prompt >") // changed — not stable yet
      .mockResolvedValue("prompt >") // stable
    const p = waitForEnginePane("kobe-x", true)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toEqual({ pane: "%3", ready: true })
    expect(capturePaneById).toHaveBeenCalledTimes(3)
  })

  it("an all-empty screen never reads as stable — the budget runs out instead", async () => {
    claudePaneIdStrict.mockResolvedValue("%3")
    capturePaneById.mockResolvedValue("   ") // trims to "" forever
    // Default (short) budget = 6s; advance past it so the wall-clock loop exits.
    const p = waitForEnginePane("kobe-x", true)
    await vi.advanceTimersByTimeAsync(6000 + 300)
    await expect(p).resolves.toEqual({ pane: "%3", ready: false })
  })

  it("budget exhausted with NO tagged pane returns pane:'' — never a first-pane guess", async () => {
    // The blind first-pane fallback is GONE: an untagged pane is a shell/ops
    // pane, and blind-pasting a prompt there is worse than reporting failure.
    claudePaneIdStrict.mockResolvedValue("")
    const p = waitForEnginePane("kobe-x", true)
    await vi.advanceTimersByTimeAsync(6000 + 300)
    await expect(p).resolves.toEqual({ pane: "", ready: false })
    // claudePaneId (the first-pane fallback) is never consulted.
    expect(claudePaneId).not.toHaveBeenCalled()
  })

  it("a longer budget keeps polling past the short default (init-script case)", async () => {
    // A repo init.sh delays the engine's first paint; the caller passes the
    // full init-script budget so the wait covers it instead of giving up at 6s.
    claudePaneIdStrict.mockResolvedValueOnce("").mockResolvedValue("%9")
    capturePaneById.mockResolvedValue("prompt >")
    const p = waitForEnginePane("kobe-x", true, 120)
    // Well past the 6s default but inside the 120s budget.
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toEqual({ pane: "%9", ready: true })
  })
})

describe("pasteAndSubmit", () => {
  it("sets + pastes a bracketed buffer, then submits Enter as a separate delayed read", async () => {
    // Composer shows the prompt's last line back → the paste is confirmed.
    capturePaneById.mockResolvedValue("prompt > line two")
    const p = pasteAndSubmit("%9", "line one\n\nline two")
    await vi.advanceTimersByTimeAsync(149)
    // Before the 150ms submit delay elapses the Enter must NOT have fired.
    expect(runTmux).toHaveBeenCalledTimes(2)
    expect(sendKeyName).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBe(true)
    expect(runTmux.mock.calls[0]?.[0]).toEqual(["set-buffer", "-b", "kobe-api-9", "--", "line one\n\nline two"])
    expect(runTmux.mock.calls[1]?.[0]).toEqual(["paste-buffer", "-p", "-d", "-b", "kobe-api-9", "-t", "%9"])
    expect(sendKeyName).toHaveBeenCalledWith("%9", "Enter")
  })

  it("returns false when the pasted text never appears in the composer", async () => {
    capturePaneById.mockResolvedValue("prompt > ") // empty composer
    const p = pasteAndSubmit("%9", "the prompt text")
    await vi.advanceTimersByTimeAsync(200)
    await expect(p).resolves.toBe(false)
    // Still submits Enter (best-effort) even though it couldn't confirm.
    expect(sendKeyName).toHaveBeenCalledWith("%9", "Enter")
  })
})

describe("deliverFirstEngineMessage", () => {
  it("delivers the message once the pane is ready, returning true when confirmed", async () => {
    claudePaneIdStrict.mockResolvedValue("%2")
    // Same stable text for the readiness probe AND the post-paste confirm, and
    // it contains the message tail → delivered:true.
    capturePaneById.mockResolvedValue("hello")
    const p = deliverFirstEngineMessage("kobe-x", { text: "hello", source: "repo-init" })
    await vi.advanceTimersByTimeAsync(2000)
    await expect(p).resolves.toBe(true)
    expect(runTmux).toHaveBeenCalledWith(["set-buffer", "-b", "kobe-api-2", "--", "hello"])
    expect(sendKeyName).toHaveBeenCalledWith("%2", "Enter")
  })

  it("returns false (no throw) when no pane appears in budget — user can still type", async () => {
    // Uses the full init-script budget (120s); advance past it.
    claudePaneIdStrict.mockResolvedValue("")
    const p = deliverFirstEngineMessage("kobe-x", { text: "hello", source: "repo-init" })
    await vi.advanceTimersByTimeAsync(120_000 + 300)
    await expect(p).resolves.toBe(false)
    expect(runTmux).not.toHaveBeenCalled()
    expect(sendKeyName).not.toHaveBeenCalled()
  })
})
