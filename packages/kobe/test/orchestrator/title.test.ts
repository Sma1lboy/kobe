import { describe, expect, it } from "vitest"
import { TITLE_CHAR_CAP, deriveTitleFromPrompt, isPlaceholderDerivedBranch } from "../../src/orchestrator/title.ts"

describe("isPlaceholderDerivedBranch", () => {
  it("recognizes the convention-era placeholder shapes", () => {
    const id = "01HXABCDEF"
    expect(isPlaceholderDerivedBranch("new-task", id)).toBe(true)
    expect(isPlaceholderDerivedBranch("feat/new-task", id)).toBe(true)
    expect(isPlaceholderDerivedBranch("new-task-2", id)).toBe(true)
    expect(isPlaceholderDerivedBranch("fix/new-task-3", id)).toBe(true)
  })

  it("recognizes the legacy rove/ and kobe/ id-suffixed placeholders", () => {
    const id = "01HXABCDEF"
    expect(isPlaceholderDerivedBranch("rove/new-task-abcdef", id)).toBe(true)
    expect(isPlaceholderDerivedBranch("kobe/new-task-abcdef", id)).toBe(true)
  })

  it("rejects real branch names", () => {
    const id = "01HXABCDEF"
    expect(isPlaceholderDerivedBranch("kobe/real-work-abcdef", id)).toBe(false)
    expect(isPlaceholderDerivedBranch("feat/login-flow", id)).toBe(false)
    expect(isPlaceholderDerivedBranch("rove/new-task-zzzzzz", id)).toBe(false)
  })
})

describe("deriveTitleFromPrompt", () => {
  it("collapses whitespace into a one-line label", () => {
    expect(deriveTitleFromPrompt("  add   a\n  feature ")).toBe("add a feature")
  })

  it("returns '' for empty / non-string input", () => {
    expect(deriveTitleFromPrompt("")).toBe("")
    expect(deriveTitleFromPrompt("   \n  ")).toBe("")
    expect(deriveTitleFromPrompt(undefined as unknown as string)).toBe("")
  })

  it("truncates with an ellipsis past the cap", () => {
    const long = "x".repeat(TITLE_CHAR_CAP + 20)
    const out = deriveTitleFromPrompt(long)
    expect(out.endsWith("…")).toBe(true)
    expect([...out].length).toBe(TITLE_CHAR_CAP + 1) // capped chars + the ellipsis
  })

  it("never splits a surrogate pair when truncating at the cap", () => {
    // An emoji straddling the cut point must not be bisected into an orphaned
    // half (which renders as a replacement glyph).
    const prompt = `${"x".repeat(TITLE_CHAR_CAP - 1)}😀tail`
    const out = deriveTitleFromPrompt(prompt)
    expect(out.endsWith("…")).toBe(true)
    expect(out).not.toContain("�")
    // No lone surrogate: a UTF-8 round-trip is lossless only if every surrogate
    // is paired.
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out)
  })
})
