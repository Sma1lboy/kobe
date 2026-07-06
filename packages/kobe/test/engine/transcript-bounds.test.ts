import { describe, expect, it } from "vitest"
import { parseJsonl as parseClaudeJsonl } from "../../src/engine/claude-code-local/history.ts"
import {
  type HistoryDeps,
  listRolloutFiles,
  parseJsonl as parseCodexJsonl,
} from "../../src/engine/codex-local/history.ts"
import { MAX_JSONL_LINE_CHARS } from "../../src/engine/file-bounds.ts"

describe("claude parseJsonl mega-line bound", () => {
  it("skips a JSONL line longer than the cap while keeping normal records", () => {
    const huge = "a".repeat(MAX_JSONL_LINE_CHARS + 1)
    const megaLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: huge },
      timestamp: "2026-06-26T00:00:00.000Z",
      sessionId: "s",
    })
    const normalLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
      timestamp: "2026-06-26T00:00:01.000Z",
      sessionId: "s",
    })
    const out = parseClaudeJsonl(`${megaLine}\n${normalLine}`, "s")
    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([{ type: "text", text: "hi" }])
  })
})

describe("codex parseJsonl mega-line bound", () => {
  it("skips a JSONL line longer than the cap while keeping normal records", () => {
    const huge = "a".repeat(MAX_JSONL_LINE_CHARS + 1)
    const megaLine = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: huge }] },
    })
    const normalLine = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    })
    const out = parseCodexJsonl(`${megaLine}\n${normalLine}`, "s")
    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([{ type: "text", text: "ok" }])
  })
})

describe("codex listRolloutFiles traversal cap", () => {
  it("collects at most MAX_ROLLOUT_FILES paths from a pathological tree", async () => {
    const OVER = 5001
    const files = Array.from(
      { length: OVER },
      (_, i) => `rollout-2026-06-10T00-00-00-${String(i).padStart(12, "0")}.jsonl`,
    )
    const deps: HistoryDeps = {
      sessionsDir: () => "/s",
      readdir: async (p) => {
        if (p === "/s") return ["2026"]
        if (p === "/s/2026") return ["06"]
        if (p === "/s/2026/06") return ["10"]
        if (p === "/s/2026/06/10") return files
        return []
      },
      readFile: async () => "",
      stat: async () => ({ mtimeMs: 0 }),
    }
    const out = await listRolloutFiles(deps)
    expect(out).toHaveLength(5000)
  })
})
