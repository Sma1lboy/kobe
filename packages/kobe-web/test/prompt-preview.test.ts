import { beforeEach, describe, expect, it } from "vitest"
import type { ContentBlock, HistoryMessage } from "../src/lib/history.ts"
import {
  collapsePreviewLine,
  extractPromptPreview,
  getPromptPreviews,
  PREVIEW_MAX_CHARS,
  prunePromptPreviews,
  resetPromptPreviews,
} from "../src/lib/prompt-preview.ts"

// Why this matters: the prompt-preview extraction must show the last thing the
// user actually TYPED — not Codex's tool-result plumbing on role:"user"
// records, not assistant prose. prunePromptPreviews is the store-driven sweep
// store.ts runs to keep cached previews in step with the live task list.

function msg(
  role: HistoryMessage["role"],
  blocks: ContentBlock[],
): HistoryMessage {
  return { role, blocks, timestamp: "2026-06-11T00:00:00Z", sessionId: "s1" }
}

const text = (t: string): ContentBlock => ({ type: "text", text: t })
const toolResult: ContentBlock = {
  type: "tool_result",
  callId: "c1",
  output: "ok",
  isError: false,
}

describe("collapsePreviewLine", () => {
  it("collapses newlines and runs of whitespace to single spaces", () => {
    expect(collapsePreviewLine("  fix\n\nthe   bug\t now ")).toBe(
      "fix the bug now",
    )
  })

  it("caps long prompts with an ellipsis", () => {
    const long = "x".repeat(PREVIEW_MAX_CHARS + 50)
    const out = collapsePreviewLine(long)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 1)
  })
})

describe("extractPromptPreview", () => {
  it("returns the LAST user prompt", () => {
    const preview = extractPromptPreview([
      msg("user", [text("first ask")]),
      msg("assistant", [text("done")]),
      msg("user", [text("second ask")]),
    ])
    expect(preview).toBe("second ask")
  })

  it("skips tool_result-only user records (Codex plumbing) back to real prose", () => {
    const preview = extractPromptPreview([
      msg("user", [text("real prompt")]),
      msg("assistant", [text("working…")]),
      msg("user", [toolResult]),
      msg("user", [toolResult]),
    ])
    expect(preview).toBe("real prompt")
  })

  it("never previews assistant or system text", () => {
    const preview = extractPromptPreview([
      msg("system", [text("session start")]),
      msg("assistant", [text("hello, how can I help?")]),
    ])
    expect(preview).toBeNull()
  })

  it("skips whitespace-only user text", () => {
    const preview = extractPromptPreview([
      msg("user", [text("the actual ask")]),
      msg("user", [text("   \n  ")]),
    ])
    expect(preview).toBe("the actual ask")
  })

  it("returns null for an empty transcript", () => {
    expect(extractPromptPreview([])).toBeNull()
  })
})

describe("prunePromptPreviews", () => {
  beforeEach(() => {
    resetPromptPreviews()
  })

  it("leaves an empty store untouched", () => {
    prunePromptPreviews(new Set(["t1"]))
    expect(getPromptPreviews()).toEqual({})
  })
})
