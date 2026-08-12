/**
 * ESC-interrupt observer (issue #15) — the "打断后 sidebar 状态 N 秒内翻转"
 * behavior. An ESC interrupt runs NO hook (claude-code's abort path returns
 * before its stop hooks), so the observer reads the engine's own title
 * rewrite — working frame → resting form — against a hook-claimed `running`,
 * debounces the Stop race, and reports `turn-interrupted`.
 */

import { afterEach, describe, expect, it } from "vitest"
import { engineTitleTurnHint } from "../../src/engine/registry"
import { InterruptObserver } from "../../src/tui/workspace/interrupt-observer"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function observer(opts: { confirm?: (tabId: string) => boolean; confirmMs?: number }) {
  const reported: string[] = []
  const o = new InterruptObserver({
    confirm: opts.confirm ?? (() => true),
    report: (tabId) => reported.push(tabId),
    confirmMs: opts.confirmMs ?? 20,
  })
  observers.push(o)
  return { o, reported }
}

const observers: InterruptObserver[] = []
afterEach(() => {
  for (const o of observers.splice(0)) o.dispose()
})

describe("engineTitleTurnHint", () => {
  it("reads claude's animated frames as working and its static ✳ as rest", () => {
    expect(engineTitleTurnHint("claude", "⠂ 修复构建失败")).toBe("working")
    expect(engineTitleTurnHint("claude", "⠐ 修复构建失败")).toBe("working")
    expect(engineTitleTurnHint("claude", "◐ 修复构建失败")).toBe("working")
    expect(engineTitleTurnHint("claude", "◑ 修复构建失败")).toBe("working")
    expect(engineTitleTurnHint("claude", "✳ 修复构建失败")).toBe("rest")
    expect(engineTitleTurnHint("claude", "修复构建失败")).toBe("rest")
  })

  it("reads codex's braille frame as working and a bare title as rest", () => {
    expect(engineTitleTurnHint("codex", "⠹ add the ruler")).toBe("working")
    expect(engineTitleTurnHint("codex", "add the ruler")).toBe("rest")
  })

  it("never claims rest without a declared working vocabulary or a title", () => {
    // copilot/custom declare no workingPrefixes — silence fallback territory,
    // a missing vocabulary must not read as "at rest".
    expect(engineTitleTurnHint("copilot", "copilot-run")).toBeNull()
    expect(engineTitleTurnHint("someWrapper", "anything")).toBeNull()
    expect(engineTitleTurnHint("claude", "")).toBeNull()
    expect(engineTitleTurnHint("claude", "   ")).toBeNull()
  })
})

describe("InterruptObserver", () => {
  it("reports a hook-running tab whose title rested for the confirm window", async () => {
    const { o, reported } = observer({})
    o.observe("tab-1", { rawTitle: "✳ 修复构建失败", vendor: "claude", hookRunning: true })
    expect(reported).toEqual([])
    await wait(60)
    expect(reported).toEqual(["tab-1"])
  })

  it("a Stop landing inside the window wins — the pending confirm disarms", async () => {
    const { o, reported } = observer({})
    o.observe("tab-1", { rawTitle: "✳ 修复构建失败", vendor: "claude", hookRunning: true })
    // Natural turn end: the daemon's turn_complete arrives, the hook state
    // leaves `running`, and the next observation pass disarms the timer.
    o.observe("tab-1", { rawTitle: "✳ 修复构建失败", vendor: "claude", hookRunning: false })
    await wait(60)
    expect(reported).toEqual([])
  })

  it("the fire-time confirm re-checks live state, not the arm-time snapshot", async () => {
    // No observation pass happened during the window (nothing re-rendered),
    // but the daemon state moved — the confirm callback is the last gate.
    const { o, reported } = observer({ confirm: () => false })
    o.observe("tab-1", { rawTitle: "✳ done", vendor: "claude", hookRunning: true })
    await wait(60)
    expect(reported).toEqual([])
  })

  it("a title back on a working frame disarms (the engine resumed)", async () => {
    const { o, reported } = observer({})
    o.observe("tab-1", { rawTitle: "✳ pausing", vendor: "claude", hookRunning: true })
    o.observe("tab-1", { rawTitle: "⠂ pausing", vendor: "claude", hookRunning: true })
    await wait(60)
    expect(reported).toEqual([])
  })

  it("never arms without a resting verdict: unknown vendor, no title, or not running", async () => {
    const { o, reported } = observer({})
    o.observe("tab-1", { rawTitle: "anything", vendor: undefined, hookRunning: true })
    o.observe("tab-2", { rawTitle: undefined, vendor: "claude", hookRunning: true })
    o.observe("tab-3", { rawTitle: "copilot-run", vendor: "copilot", hookRunning: true })
    o.observe("tab-4", { rawTitle: "✳ resting", vendor: "claude", hookRunning: false })
    await wait(60)
    expect(reported).toEqual([])
  })

  it("re-observing while pending neither restarts nor duplicates the confirm", async () => {
    const { o, reported } = observer({ confirmMs: 40 })
    o.observe("tab-1", { rawTitle: "✳ done", vendor: "claude", hookRunning: true })
    await wait(25)
    // Same disagreement re-observed mid-window (a render tick) must not
    // push the deadline back.
    o.observe("tab-1", { rawTitle: "✳ done", vendor: "claude", hookRunning: true })
    await wait(25)
    expect(reported).toEqual(["tab-1"])
    await wait(50)
    expect(reported).toEqual(["tab-1"])
  })
})
