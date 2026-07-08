import { beforeEach, describe, expect, it, vi } from "vitest"
import { MockTaskPty } from "../../src/tui/panes/terminal/pty-mock"
import { deliverInitialPrompt, waitAndDeliverInitialPrompt } from "../../src/tui/workspace/quick-fork-delivery"

function mockPty(): MockTaskPty {
  return new MockTaskPty({ taskId: "t1", cwd: "/tmp" })
}

beforeEach(() => {
  vi.useRealTimers()
})

describe("deliverInitialPrompt", () => {
  it("delivers on the first output chunk (engine banner) and unsubscribes", async () => {
    const pty = mockPty()
    const promise = deliverInitialPrompt(pty, "fix the bug", 5000)
    pty.feed("Claude Code v1\n")
    const result = await promise
    expect(result.delivered).toBe(true)
    expect(pty.pastes).toEqual(["fix the bug"])
    expect(pty.writeLog).toEqual(["\r"])
  })

  it("delivers immediately when the pty already has a snapshot (onData replay)", async () => {
    const pty = mockPty()
    pty.feed("already booted\n")
    const result = await deliverInitialPrompt(pty, "hello", 5000)
    expect(result.delivered).toBe(true)
    expect(pty.pastes).toEqual(["hello"])
  })

  it("times out without delivering when the engine never produces output", async () => {
    vi.useFakeTimers()
    const pty = mockPty()
    const promise = deliverInitialPrompt(pty, "fix the bug", 5000)
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise
    expect(result.delivered).toBe(false)
    expect(pty.pastes).toEqual([])
    vi.useRealTimers()
  })

  it("never delivers into a pty that exits before producing output", async () => {
    const pty = mockPty()
    const promise = deliverInitialPrompt(pty, "fix the bug", 5000)
    pty.kill()
    const result = await promise
    expect(result.delivered).toBe(false)
    expect(pty.pastes).toEqual([])
  })

  it("is a no-op against an already-dead pty", async () => {
    const pty = mockPty()
    pty.kill()
    const result = await deliverInitialPrompt(pty, "fix the bug", 5000)
    expect(result.delivered).toBe(false)
  })

  it("ignores output that arrives after the timeout already settled", async () => {
    vi.useFakeTimers()
    const pty = mockPty()
    const promise = deliverInitialPrompt(pty, "fix the bug", 1000)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await promise
    pty.feed("late banner\n")
    expect(result.delivered).toBe(false)
    expect(pty.pastes).toEqual([])
    vi.useRealTimers()
  })
})

describe("waitAndDeliverInitialPrompt", () => {
  it("polls until the pty is acquired, then delivers on its first chunk", async () => {
    vi.useFakeTimers()
    let pty: MockTaskPty | null = null
    const promise = waitAndDeliverInitialPrompt(() => pty, "fix the bug", 5000)
    await vi.advanceTimersByTimeAsync(120)
    pty = mockPty()
    await vi.advanceTimersByTimeAsync(60)
    pty.feed("banner\n")
    const result = await promise
    expect(result.delivered).toBe(true)
    expect(pty.pastes).toEqual(["fix the bug"])
    vi.useRealTimers()
  })

  it("times out if the pty is never acquired", async () => {
    vi.useFakeTimers()
    const promise = waitAndDeliverInitialPrompt(() => null, "fix the bug", 500)
    await vi.advanceTimersByTimeAsync(500)
    const result = await promise
    expect(result.delivered).toBe(false)
    vi.useRealTimers()
  })

  it("stops polling once the signal aborts", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const promise = waitAndDeliverInitialPrompt(() => null, "fix the bug", 5000, controller.signal)
    controller.abort()
    await vi.advanceTimersByTimeAsync(50)
    const result = await promise
    expect(result.delivered).toBe(false)
    vi.useRealTimers()
  })
})
