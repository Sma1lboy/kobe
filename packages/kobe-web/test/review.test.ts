import { describe, expect, it } from "vitest"
import { createPrPrompt, reviewPrompt } from "../src/lib/review.ts"

/**
 * One-click review instruction. Load-bearing: claude gets its native
 * /review command (no re-taught checklist) plus ONLY the click-scoped
 * `done` authorization; the CLI path is the top-level `kobe api
 * set-status` (NOT the bogus `api edit` form a field agent once hit);
 * and a failing review must leave the status untouched.
 */
describe("reviewPrompt", () => {
  it("claude: leads with the native /review command", () => {
    const text = reviewPrompt("01HXABC", "claude")
    expect(text.startsWith("/review\n")).toBe(true)
    expect(text).toContain("kobe api set-status --task-id 01HXABC --status done")
    expect(text).not.toContain("api edit")
  })

  it("missing vendor defaults to claude (house convention)", () => {
    expect(reviewPrompt("t1", undefined).startsWith("/review")).toBe(true)
  })

  it("non-claude engines get the prose form with the same done clause", () => {
    const text = reviewPrompt("t1", "codex")
    expect(text).not.toContain("/review")
    expect(text).toContain("kobe api set-status --task-id t1 --status done")
  })

  it("a failing review keeps the status unchanged, in every form", () => {
    for (const vendor of ["claude", "codex"]) {
      expect(reviewPrompt("t1", vendor)).toContain("leave the status unchanged")
    }
  })
})

describe("createPrPrompt", () => {
  it("pushes, creates via gh, returns the URL, and never forces", () => {
    const text = createPrPrompt()
    expect(text).toContain("push the branch")
    expect(text).toContain("gh pr create")
    expect(text).toContain("Reply with the PR URL")
    expect(text).toContain("say so instead of forcing it")
  })
})

describe("user templates — kobe's clause is APPENDED, never replaced", () => {
  it("a custom review template swaps the base, the done clause survives", () => {
    const text = reviewPrompt("t1", "claude", "/review focus on security")
    expect(text.startsWith("/review focus on security\n")).toBe(true)
    expect(text).toContain("--status done")
    expect(text).toContain("leave the status unchanged")
  })

  it("a blank/whitespace template falls back to the built-in default", () => {
    expect(reviewPrompt("t1", "claude", "   ").startsWith("/review\n")).toBe(true)
    expect(reviewPrompt("t1", "claude", null).startsWith("/review\n")).toBe(true)
  })

  it("a custom PR template keeps the URL + never-force tail", () => {
    const text = createPrPrompt("Open a DRAFT pr with gh pr create --draft")
    expect(text.startsWith("Open a DRAFT pr")).toBe(true)
    expect(text).toContain("Reply with the PR URL")
    expect(text).toContain("say so instead of forcing it")
  })
})
