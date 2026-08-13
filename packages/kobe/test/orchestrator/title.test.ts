import { describe, expect, it } from "vitest"
import { TITLE_CHAR_CAP, autoBranch, deriveTitleFromPrompt } from "../../src/orchestrator/title.ts"

describe("autoBranch", () => {
  it("builds rove/<slug>-<id6> from title + task id", () => {
    expect(autoBranch("(new task)", "01HXABCDEF")).toBe("rove/new-task-abcdef")
  })

  it("gives placeholder-titled tasks DISTINCT branches via the id suffix", () => {
    // The bug (KOB-244): every new task derived the same branch and the 2nd
    // `git worktree add -b` collided. Distinct ids → distinct branches.
    const a = autoBranch("(new task)", "01HXAAAAAA")
    const b = autoBranch("(new task)", "01HXBBBBBB")
    expect(a).not.toBe(b)
    expect(a).toBe("rove/new-task-aaaaaa")
    expect(b).toBe("rove/new-task-bbbbbb")
  })

  it("falls back to 'task' when the title has no slug-able chars", () => {
    expect(autoBranch("!!!", "01HXZZZZZZ")).toBe("rove/task-zzzzzz")
    expect(autoBranch("", "01HXZZZZZZ")).toBe("rove/task-zzzzzz")
  })

  it("lowercases + dash-collapses + caps the slug at 32 chars", () => {
    const branch = autoBranch("Fix The Very Long Feature Name That Exceeds The Cap!!", "01HXQQQQQQ")
    const slug = branch.slice("rove/".length, -"-qqqqqq".length)
    expect(slug.length).toBeLessThanOrEqual(32)
    expect(slug).toBe("fix-the-very-long-feature-name-t")
  })

  it("never emits a double hyphen when the 32-char cap lands on a word boundary", () => {
    // The trailing-hyphen trim runs BEFORE the .slice(0, 32) cap, so a slice
    // that ends on a `-` used to survive into the template as `rove/<slug>--<id>`.
    // Reachable whenever char 33 is a word boundary: 31 slug chars + a space + a word.
    const branch = autoBranch(`${"a".repeat(31)} bar`, "01HXQQQQQQ")
    expect(branch).toBe(`rove/${"a".repeat(31)}-qqqqqq`)
    expect(branch).not.toContain("--")
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
