import { embeddedTerminalEnv } from "@sma1lboy/kobe-daemon/daemon/pty-env"
import { describe, expect, it } from "vitest"

describe("embeddedTerminalEnv", () => {
  it("removes the outer terminal identity while retaining capabilities and overrides", () => {
    const base = {
      TERM_PROGRAM: "iTerm.app",
      TERM_PROGRAM_VERSION: "3.6.11",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: "/home/test",
    }

    const result = embeddedTerminalEnv(base, { KOBE_TERMINAL_PTY: "1" })

    expect(result).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: "/home/test",
      KOBE_TERMINAL_PTY: "1",
    })
    expect(base.TERM_PROGRAM).toBe("iTerm.app")
  })
})
