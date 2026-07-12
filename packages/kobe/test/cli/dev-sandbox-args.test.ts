import { describe, expect, it } from "vitest"
import { parseSandboxArgs } from "../../scripts/dev-sandbox-args"

describe("parseSandboxArgs", () => {
  it("defaults to run with the production PureTUI default", () => {
    expect(parseSandboxArgs(["run"])).toEqual({ mode: "run" })
  })

  it.each(["--puretui", "--tmux"] as const)("forwards %s for run", (launchFlag) => {
    expect(parseSandboxArgs(["run", launchFlag])).toEqual({ mode: "run", launchFlag })
  })

  it("keeps reset and home unchanged", () => {
    expect(parseSandboxArgs(["reset"])).toEqual({ mode: "reset" })
    expect(parseSandboxArgs(["home"])).toEqual({ mode: "home" })
  })

  it("rejects a launch flag for reset", () => {
    expect(() => parseSandboxArgs(["reset", "--tmux"])).toThrow("launch flags are valid only for run")
  })

  it("rejects conflicting run flags", () => {
    expect(() => parseSandboxArgs(["run", "--tmux", "--puretui"])).toThrow("cannot be used together")
  })
})
