/**
 * Pins the framework-free history transcript formatting shared by the Solid and
 * React panes. Renderer-bound TSX stays out of vitest; this file covers the
 * extracted pure logic only.
 */

import { describe, expect, it } from "vitest"
import { bodyText, relativeTime, resultsByCallId, toolInputSummary } from "../../src/tui/history/message-core"
import type { Message } from "../../src/types/engine"

describe("history message core", () => {
  it("summarizes tool input by the same field priority as the pane renderer", () => {
    expect(toolInputSummary({ query: "fallback", file_path: "src/tui/history/host.tsx" })).toBe(
      "src/tui/history/host.tsx",
    )
    expect(toolInputSummary({ command: "bun run test" })).toBe("bun run test")
    expect(toolInputSummary({})).toBe("")
  })

  it("truncates long summaries but preserves the cap", () => {
    const out = toolInputSummary({ command: "x".repeat(200) })
    expect(out).toHaveLength(120)
    expect(out.endsWith("…")).toBe(true)
  })

  it("cuts long summaries by code point — never bisects a surrogate pair", () => {
    // Each 🎉 is one code point but two UTF-16 units; the old
    // `.slice(0, 119)` by UTF-16 length could cut mid-pair and emit a lone
    // surrogate (→ �). truncateEnd counts code points instead.
    const out = toolInputSummary({ command: "🎉".repeat(200) })
    expect(out).toBe(`${"🎉".repeat(119)}…`)
  })

  it("stringifies expanded tool bodies without throwing", () => {
    expect(bodyText("plain")).toBe("plain")
    expect(bodyText({ ok: true })).toBe(JSON.stringify({ ok: true }, null, 2))
    expect(bodyText(Symbol("s"))).toBe("Symbol(s)")
  })

  it("indexes the latest tool result by call id", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        sessionId: "s",
        timestamp: "2026-01-01T00:00:00.000Z",
        blocks: [{ type: "tool_result", callId: "c1", output: "old", isError: false }],
      },
      {
        role: "user",
        sessionId: "s",
        timestamp: "2026-01-01T00:00:01.000Z",
        blocks: [{ type: "tool_result", callId: "c1", output: "new", isError: true }],
      },
    ]
    expect(resultsByCallId(messages).get("c1")).toMatchObject({ output: "new", isError: true })
  })

  it("formats relative timestamps and suppresses invalid values", () => {
    expect(relativeTime("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:30.000Z"))).toBe("30s")
    expect(relativeTime("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:02:00.000Z"))).toBe("2m")
    expect(relativeTime("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T03:00:00.000Z"))).toBe("3h")
    expect(relativeTime("2026-01-01T00:00:00.000Z", Date.parse("2026-01-04T00:00:00.000Z"))).toBe("3d")
    expect(relativeTime("not-a-date")).toBe("")
  })
})
