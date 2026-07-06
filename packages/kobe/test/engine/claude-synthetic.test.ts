import { describe, expect, it } from "vitest"
import { parseJsonl } from "../../src/engine/claude-code-local/history.ts"
import { isClaudeCommandBreadcrumb, isSyntheticClaudeRecord } from "../../src/engine/claude-code-local/synthetic.ts"

/**
 * Claude persists injected rows (the local-command caveat as `isMeta`, the
 * `<command-name>` slash-command breadcrumb as a plain user record) BEFORE the
 * real prompt. They must be dropped from the neutral Message[] so auto-title
 * names a task from the user's actual first prompt, not the boilerplate —
 * mirroring Claude Code's own human-turn filter.
 */

describe("isSyntheticClaudeRecord", () => {
  it("flags isMeta and isCompactSummary records", () => {
    expect(isSyntheticClaudeRecord({ isMeta: true })).toBe(true)
    expect(isSyntheticClaudeRecord({ isCompactSummary: true })).toBe(true)
  })

  it("does not flag an ordinary record", () => {
    expect(isSyntheticClaudeRecord({})).toBe(false)
    expect(isSyntheticClaudeRecord({ isMeta: false })).toBe(false)
  })
})

describe("isClaudeCommandBreadcrumb", () => {
  it("flags a user row whose only text is a command envelope", () => {
    expect(isClaudeCommandBreadcrumb([{ type: "text", text: "<command-name>/clear</command-name>" }])).toBe(true)
  })

  it("preserves a row with real prose", () => {
    expect(isClaudeCommandBreadcrumb([{ type: "text", text: "fix the login bug" }])).toBe(false)
    expect(isClaudeCommandBreadcrumb([])).toBe(false)
  })
})

describe("parseJsonl drops synthetic first rows", () => {
  it("skips the caveat + command breadcrumb so the real prompt is first", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>Caveat: …</local-command-caveat>" },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/model</command-name><command-message>model</command-message>",
        },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "actually fix the parser" } }),
    ].join("\n")
    const messages = parseJsonl(raw, "s1")
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([{ type: "text", text: "actually fix the parser" }])
  })

  it("keeps a normal first user prompt untouched", () => {
    const raw = JSON.stringify({ type: "user", message: { role: "user", content: "hello world" } })
    expect(parseJsonl(raw, "s1")[0]?.blocks).toEqual([{ type: "text", text: "hello world" }])
  })
})
