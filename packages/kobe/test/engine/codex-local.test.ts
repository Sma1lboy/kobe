import { describe, expect, it } from "vitest"
import { normalizeCodexContent } from "../../src/engine/codex-local/normalize.ts"
import { isSyntheticCodexUserRow, visibleCodexUserText } from "../../src/engine/codex-local/synthetic.ts"
import { codexUsageToSnapshot } from "../../src/engine/codex-local/usage.ts"

describe("normalizeCodexContent", () => {
  it("wraps a non-empty string as one text block", () => {
    expect(normalizeCodexContent("hi")).toEqual([{ type: "text", text: "hi" }])
  })

  it("returns [] for an empty string or a non-array value", () => {
    expect(normalizeCodexContent("")).toEqual([])
    expect(normalizeCodexContent(null)).toEqual([])
    expect(normalizeCodexContent(42)).toEqual([])
    expect(normalizeCodexContent({ type: "input_text", text: "x" })).toEqual([])
  })

  it("maps input_text / output_text to text blocks", () => {
    expect(
      normalizeCodexContent([
        { type: "input_text", text: "u" },
        { type: "output_text", text: "a" },
      ]),
    ).toEqual([
      { type: "text", text: "u" },
      { type: "text", text: "a" },
    ])
  })

  it("drops empty text and keeps bare string items", () => {
    expect(normalizeCodexContent([{ type: "input_text", text: "" }, "raw"])).toEqual([{ type: "text", text: "raw" }])
  })

  it("renders an unknown block type as a placeholder", () => {
    expect(normalizeCodexContent([{ type: "image" }])).toEqual([{ type: "text", text: "[codex: image]" }])
  })

  it("skips object items with no type", () => {
    expect(normalizeCodexContent([{ text: "no type" }])).toEqual([])
  })
})

describe("isSyntheticCodexUserRow", () => {
  it("is false for an empty list", () => {
    expect(isSyntheticCodexUserRow([])).toBe(false)
  })

  it("detects an environment_context envelope", () => {
    expect(isSyntheticCodexUserRow([{ type: "text", text: "<environment_context>cwd</environment_context>" }])).toBe(
      true,
    )
  })

  it("detects an AGENTS.md instructions envelope", () => {
    const text = "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nbe terse\n</INSTRUCTIONS>"
    expect(isSyntheticCodexUserRow([{ type: "text", text }])).toBe(true)
  })

  it("is false when a real block is mixed in with an envelope", () => {
    expect(
      isSyntheticCodexUserRow([
        { type: "text", text: "<environment_context>x</environment_context>" },
        { type: "text", text: "actual question" },
      ]),
    ).toBe(false)
  })

  it("is false for a non-text block", () => {
    expect(isSyntheticCodexUserRow([{ type: "image" }])).toBe(false)
  })
})

describe("visibleCodexUserText", () => {
  it("returns the real user text", () => {
    expect(visibleCodexUserText([{ type: "input_text", text: "real prompt" }])).toBe("real prompt")
    expect(visibleCodexUserText("plain")).toBe("plain")
  })

  it("returns null for a synthetic envelope row", () => {
    expect(
      visibleCodexUserText([{ type: "input_text", text: "<environment_context>x</environment_context>" }]),
    ).toBeNull()
  })

  it("returns null when there is no text", () => {
    expect(visibleCodexUserText([])).toBeNull()
  })
})

describe("codexUsageToSnapshot", () => {
  it("subtracts cached input from total and reports the cache read", () => {
    expect(codexUsageToSnapshot({ input_tokens: 100, cached_input_tokens: 30, output_tokens: 50 })).toEqual({
      input_tokens: 70,
      output_tokens: 50,
      cache_read_input_tokens: 30,
    })
  })

  it("omits the cache field when nothing was cached", () => {
    expect(codexUsageToSnapshot({ input_tokens: 100, output_tokens: 50 })).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    })
  })

  it("clamps non-cached input at zero", () => {
    expect(codexUsageToSnapshot({ input_tokens: 20, cached_input_tokens: 50 })).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 50,
    })
  })

  it("returns undefined when every counter is empty", () => {
    expect(codexUsageToSnapshot({})).toBeUndefined()
    expect(codexUsageToSnapshot({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
  })

  it("carries a positive context window through, ignoring non-positive", () => {
    expect(codexUsageToSnapshot({ output_tokens: 10 }, { contextWindowTokens: 200_000 })).toEqual({
      input_tokens: 0,
      output_tokens: 10,
      context_window_tokens: 200_000,
    })
    expect(codexUsageToSnapshot({ output_tokens: 10 }, { contextWindowTokens: 0 })).toEqual({
      input_tokens: 0,
      output_tokens: 10,
    })
  })
})
