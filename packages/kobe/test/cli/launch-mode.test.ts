import { describe, expect, it } from "vitest"
import { parseLaunchRequest } from "../../src/launch-mode"

describe("parseLaunchRequest", () => {
  it("defaults a bare invocation to PureTUI", () => {
    expect(parseLaunchRequest([])).toEqual({ kind: "launch", mode: "puretui" })
  })

  it.each([
    ["--puretui", "puretui"],
    ["--tmux", "tmux"],
  ] as const)("maps %s to %s", (flag, mode) => {
    expect(parseLaunchRequest([flag])).toEqual({ kind: "launch", mode })
  })

  it("keeps ordinary subcommands untouched", () => {
    expect(parseLaunchRequest(["doctor", "--bogus"])).toEqual({
      kind: "command",
      args: ["doctor", "--bogus"],
    })
  })

  it("rejects conflicting launch flags", () => {
    expect(parseLaunchRequest(["--tmux", "--puretui"])).toEqual({
      kind: "error",
      message: "kobe: --tmux and --puretui cannot be used together",
    })
  })

  it("rejects arguments after a launch flag", () => {
    expect(parseLaunchRequest(["--tmux", "doctor"])).toEqual({
      kind: "error",
      message: 'kobe: launch flag "--tmux" does not accept argument "doctor"',
    })
  })
})
