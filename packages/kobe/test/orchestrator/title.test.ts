import { describe, expect, it } from "vitest"
import { TITLE_CHAR_CAP, autoBranch, deriveTitleFromPrompt } from "../../src/orchestrator/title.ts"

describe("autoBranch", () => {
  it("builds kobe/<slug>-<id6> from title + task id", () => {
    expect(autoBranch("(new task)", "01HXABCDEF")).toBe("kobe/new-task-abcdef")
  })

  it("gives placeholder-titled tasks DISTINCT branches via the id suffix", () => {
    // The bug (KOB-244): every new task derived the same branch and the 2nd
    // `git worktree add -b` collided. Distinct ids → distinct branches.
    const a = autoBranch("(new task)", "01HXAAAAAA")
    const b = autoBranch("(new task)", "01HXBBBBBB")
    expect(a).not.toBe(b)
    expect(a).toBe("kobe/new-task-aaaaaa")
    expect(b).toBe("kobe/new-task-bbbbbb")
  })

  it("falls back to 'task' when the title has no slug-able chars", () => {
    expect(autoBranch("!!!", "01HXZZZZZZ")).toBe("kobe/task-zzzzzz")
    expect(autoBranch("", "01HXZZZZZZ")).toBe("kobe/task-zzzzzz")
  })

  it("lowercases + dash-collapses + caps the slug at 32 chars", () => {
    const branch = autoBranch("Fix The Very Long Feature Name That Exceeds The Cap!!", "01HXQQQQQQ")
    const slug = branch.slice("kobe/".length, -"-qqqqqq".length)
    expect(slug.length).toBeLessThanOrEqual(32)
    expect(slug).toBe("fix-the-very-long-feature-name-t")
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
