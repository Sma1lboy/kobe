import { describe, expect, it } from "vitest"
import type { TimelineItem } from "../src/lib/timeline.ts"
import {
  quoteTraceItem,
  readableTraceContent,
} from "../src/lib/trace-content.ts"

const tool: TimelineItem = {
  id: "tool-1",
  turnId: "turn-1",
  parentId: null,
  parentBasis: "none",
  kind: "tool",
  status: "success",
  title: "exec",
  summary: "git status",
  detail:
    '{"cmd":"git status --short","workdir":"/repo","yield_time_ms":10000,"max_output_tokens":3000}',
  resultDetail:
    '{"output":" M src/app.ts","exit_code":0,"wall_time_seconds":1.5}',
  startedAt: 1,
  endedAt: 2,
}

describe("trace content presentation", () => {
  it("turns JSON-shaped tool input into labeled human-readable fields", () => {
    expect(readableTraceContent("Input", tool.detail)).toEqual([
      { label: "Command", text: "git status --short", tone: "code" },
      { label: "Working directory", text: "/repo", tone: "value" },
      { label: "Wait", text: "10 s", tone: "value" },
      { label: "Output limit", text: "3,000 tokens", tone: "value" },
    ])
  })

  it("keeps plain prose intact instead of treating it as JSON", () => {
    expect(readableTraceContent("Reasoning summary", "Inspect the adapter first.")).toEqual([
      {
        label: "Reasoning summary",
        text: "Inspect the adapter first.",
        tone: "prose",
      },
    ])
  })

  it("builds a self-contained block reference for the next prompt", () => {
    const quote = quoteTraceItem(tool)
    expect(quote).toContain("[Quoted Agent Trace block · Tool · exec]")
    expect(quote).toContain("Command:\ngit status --short")
    expect(quote).toContain("Working directory:\n/repo")
    expect(quote).toContain("Exit code:\n0 · success")
    expect(quote).toContain("[/Quoted Agent Trace block]")
  })

  it("keeps oversized quotes inside the input cap with one closing marker", () => {
    const quote = quoteTraceItem({ ...tool, resultDetail: "x".repeat(20_000) })
    expect(quote.length).toBeLessThanOrEqual(16_000)
    expect(quote).toContain("[quoted block truncated]")
    expect(quote.match(/\[\/Quoted Agent Trace block\]/g)).toHaveLength(1)
    expect(quote.endsWith("[/Quoted Agent Trace block]")).toBe(true)
  })
})
