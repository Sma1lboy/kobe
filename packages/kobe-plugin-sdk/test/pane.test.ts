import { describe, expect, it } from "vitest"
import { parseKeys } from "../src/pane.ts"

describe("parseKeys", () => {
  it("parses printables, specials, arrows, and ctrl chords", () => {
    expect(parseKeys("a")).toEqual([{ name: "a", ctrl: false }])
    expect(parseKeys("\r")).toEqual([{ name: "enter", ctrl: false }])
    expect(parseKeys("\x1b[A")).toEqual([{ name: "up", ctrl: false }])
    expect(parseKeys("\x1b")).toEqual([{ name: "escape", ctrl: false }])
    expect(parseKeys("\x03")).toEqual([{ name: "c", ctrl: true }])
    expect(parseKeys("\x7f")).toEqual([{ name: "backspace", ctrl: false }])
  })

  it("splits a burst chunk into ordered keys", () => {
    expect(parseKeys("ab\x1b[D\t").map((k) => k.name)).toEqual(["a", "b", "left", "tab"])
  })
})
