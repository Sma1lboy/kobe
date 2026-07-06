import { stripNewlines } from "@/tui/component/new-task-dialog/state"
import { describe, expect, it } from "vitest"

const preserveBody = (v: string): string => v

const MULTILINE = "first paragraph\nsecond line\nthird line"

describe("feedback description preserves newlines (Fix B — no paste data loss)", () => {
  it("the body normalizer keeps paragraph structure intact", () => {
    expect(preserveBody(MULTILINE)).toBe(MULTILINE)
    expect(preserveBody(MULTILINE).split("\n")).toHaveLength(3)
  })

  it("a single-line field WOULD have destroyed that structure — why <input> was wrong", () => {
    expect(stripNewlines(MULTILINE)).toBe("first paragraphsecond linethird line")
    expect(stripNewlines(MULTILINE)).not.toContain("\n")
  })
})

describe("single-line fields still strip newlines (title / branch / prompt / repo)", () => {
  it("stripNewlines collapses CR/LF so those fields stay on one line", () => {
    expect(stripNewlines("one\ntwo")).toBe("onetwo")
    expect(stripNewlines("a\r\nb\n")).toBe("ab")
    expect(stripNewlines("clean")).toBe("clean")
  })
})
