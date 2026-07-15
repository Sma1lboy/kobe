import { describe, expect, it, vi } from "vitest"
import { PtyListeners } from "../../src/tui/panes/terminal/pty-listeners.ts"

describe("PtyListeners", () => {
  it("fans out data and titles without letting a bad subscriber silence another", () => {
    const listeners = new PtyListeners()
    const data = vi.fn()
    const title = vi.fn()
    listeners.addData(() => {
      throw new Error("bad data listener")
    })
    listeners.addData(data)
    listeners.addTitle(() => {
      throw new Error("bad title listener")
    })
    listeners.addTitle(title)

    listeners.publishData([], null)
    listeners.publishTitle("claude")

    expect(data).toHaveBeenCalledWith([], null)
    expect(title).toHaveBeenCalledWith("claude")
    expect(listeners.dataCount).toBe(2)
  })

  it("unsubscribes data and drains exits exactly once on terminal teardown", () => {
    const listeners = new PtyListeners()
    const data = vi.fn()
    const exit = vi.fn()
    const off = listeners.addData(data)
    listeners.addExit(exit)

    off()
    listeners.publishData([], null)
    for (const callback of listeners.drainExits()) callback()
    for (const callback of listeners.drainExits()) callback()

    expect(data).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledOnce()
    expect(listeners.dataCount).toBe(0)
  })
})
