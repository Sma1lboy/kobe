import { describe, expect, it } from "vitest"
import { ApiError, parseFlags } from "../../src/cli/api-cmd.ts"

describe("parseFlags", () => {
  it("parses long flags with =", () => {
    const { flags, pretty } = parseFlags(["--repo=/tmp/r", "--prompt=hi"])
    expect(flags.get("repo")).toBe("/tmp/r")
    expect(flags.get("prompt")).toBe("hi")
    expect(pretty).toBe(false)
  })

  it("parses long flags with separate value", () => {
    const { flags } = parseFlags(["--repo", "/tmp/r", "--prompt", "hello world"])
    expect(flags.get("repo")).toBe("/tmp/r")
    expect(flags.get("prompt")).toBe("hello world")
  })

  it("recognises --pretty as a boolean flag", () => {
    expect(parseFlags(["--pretty"]).pretty).toBe(true)
    expect(parseFlags(["--pretty=false"]).pretty).toBe(false)
    expect(parseFlags(["--pretty=0"]).pretty).toBe(false)
  })

  it("rejects positional args", () => {
    expect(() => parseFlags(["positional"])).toThrow(ApiError)
  })

  it("rejects a flag without a value", () => {
    expect(() => parseFlags(["--repo"])).toThrow(/requires a value/)
  })

  it("rejects a flag whose value looks like another flag", () => {
    // `--repo --prompt` would silently consume `--prompt` as the value
    // for `--repo` if we didn't guard against it.
    expect(() => parseFlags(["--repo", "--prompt", "hi"])).toThrow(/requires a value/)
  })
})
