import { describe, expect, it, vi } from "vitest"
import { KOBE_TERMINAL_TITLE_SEQUENCE, publishKobeTerminalTitle } from "../../src/tui/lib/outer-terminal-title.ts"

describe("publishKobeTerminalTitle", () => {
  it("writes the OSC 0 kobe title to a terminal", () => {
    const write = vi.fn()
    expect(publishKobeTerminalTitle({ isTTY: true, write })).toBe(true)
    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith(KOBE_TERMINAL_TITLE_SEQUENCE)
  })

  it("does not leak control bytes into redirected output", () => {
    const write = vi.fn()
    expect(publishKobeTerminalTitle({ isTTY: false, write })).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
