import { describe, expect, it } from "vitest"
import { ptyEnv } from "../pty-env.mjs"

describe("ptyEnv", () => {
  it("removes launcher color suppression and outer terminal identity", () => {
    const base = {
      NO_COLOR: "1",
      TERM_PROGRAM: "iTerm.app",
      TERM_PROGRAM_VERSION: "3.6.11",
      TERM: "xterm-256color",
    }

    expect(ptyEnv(base)).toEqual({
      TERM: "xterm-256color",
      CLICOLOR: "1",
      COLORTERM: "truecolor",
    })
    expect(base.NO_COLOR).toBe("1")
  })
})
