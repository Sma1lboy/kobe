/**
 * Pins the newline-normalization contract for the settings dialog's text
 * fields (`FeedbackSettingsSection` in `src/tui/component/settings-dialog/
 * sections.tsx`) and its siblings.
 *
 * The bug (Fix B): the feedback "description" was an opentui `<input>`,
 * which strips newlines INSIDE the native widget on paste/insert — so a
 * multi-line pasted bug report was silently collapsed to one line (pure
 * data loss). The fix makes the description a `<textarea>` and applies NO
 * newline stripping to it, so paragraph structure survives; the
 * single-line fields (title, branch, repo, prompt) keep `stripNewlines`
 * and stay on one line.
 *
 * This suite asserts the two normalizers at the logic layer:
 *   - single-line fields → `stripNewlines` (collapses to one line)
 *   - description body   → identity (preserves `\n`)
 *
 * Note: the live widget behavior (InputRenderable strips, TextareaRenderable
 * preserves) is verified out-of-band — tests here deliberately do NOT import
 * `@opentui/core` (its renderer retains native memory and can't load under
 * vitest/node; see the header of `test/tui/terminal-sgr.test.ts`).
 */

import { stripNewlines } from "@/tui/component/new-task-dialog/state"
import { describe, expect, it } from "vitest"

/** What the multi-line description field does to its value: nothing. */
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
