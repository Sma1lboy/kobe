import { describe, expect, it } from "vitest"
import { reviewPrompt } from "../src/lib/review.ts"

/**
 * One-click review instruction. Load-bearing: the `done` authorization
 * travels WITH the review request (the spawn-time status protocol never
 * grants it), the command path is the top-level `kobe api set-status`
 * (NOT the bogus `api edit` form a field agent once hit), and a failing
 * review must leave the status untouched.
 */
describe("reviewPrompt", () => {
  const text = reviewPrompt("01HXABC")

  it("authorizes done ONLY for this review, with the exact CLI command", () => {
    expect(text).toContain("kobe api set-status --task-id 01HXABC --status done")
    expect(text).not.toContain("api edit")
    expect(text).toContain("one-time authorization")
  })

  it("a failing review keeps the status unchanged", () => {
    expect(text).toContain("do NOT change the status")
    expect(text).not.toContain("--status in_progress")
  })
})
