import { describe, expect, it } from "vitest"
import { parseSandboxArgs } from "../../scripts/dev-sandbox-args"

describe("parseSandboxArgs", () => {
  it("defaults to the sole run mode", () => {
    expect(parseSandboxArgs(["run"])).toEqual({ mode: "run" })
    expect(parseSandboxArgs([])).toEqual({ mode: "run" })
  })

  it("keeps reset and home unchanged", () => {
    expect(parseSandboxArgs(["reset"])).toEqual({ mode: "reset" })
    expect(parseSandboxArgs(["home"])).toEqual({ mode: "home" })
  })

  it("rejects retired launch flags and extra arguments", () => {
    expect(() => parseSandboxArgs(["--tmux"])).toThrow('unknown sandbox mode "--tmux"')
    expect(() => parseSandboxArgs(["run", "extra"])).toThrow('unexpected argument "extra"')
  })
})
