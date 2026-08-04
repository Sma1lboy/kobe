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

  it("strips ancestor Claude-session markers so engines persist transcripts", () => {
    const env = ptyEnv({
      TERM: "xterm-256color",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDECODE: "1",
      CLAUDE_PID: "123",
    })
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_PID).toBeUndefined()
    expect(env.TERM).toBe("xterm-256color")
  })
})
