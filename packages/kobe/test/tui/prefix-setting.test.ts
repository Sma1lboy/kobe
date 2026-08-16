import { describe, expect, it } from "vitest"
import { normalizePrefixInput } from "../../src/tui/lib/prefix-setting"

describe("normalizePrefixInput", () => {
  it("normalizes modifier chords through the keymap grammar", () => {
    expect(normalizePrefixInput(" Control+B ")).toEqual({ key: "ctrl+b" })
  })

  it.each(["disabled", "NONE", "null"])("maps %s to a disabled prefix", (value) => {
    expect(normalizePrefixInput(value)).toEqual({ key: null })
  })

  it("rejects bare keys and invalid chords", () => {
    expect(normalizePrefixInput("b")).toEqual({
      error: "Prefix keys must include a modifier (for example ctrl+b).",
    })
    expect(normalizePrefixInput("ctrl+shift+b")).toHaveProperty("error")
  })
})
