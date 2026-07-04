/**
 * Headless `claude -p` turn driver (KOBE_TUI=1 native chat backend) —
 * pins the argv contract and the SDK-verbatim line parsing. No spawning:
 * `startHeadlessTurn`'s process wiring is exercised by using the pane.
 */

import { buildHeadlessArgs, parseSdkLine } from "@/engine/claude-code-local/headless"
import { describe, expect, it } from "vitest"

describe("buildHeadlessArgs", () => {
  it("pins the canonical arg order (resume first, stream-json last)", () => {
    expect(
      buildHeadlessArgs({ prompt: "fix the bug", resumeSessionId: "sid-1", permissionMode: "acceptEdits" }),
    ).toEqual([
      "--resume",
      "sid-1",
      "-p",
      "fix the bug",
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "stream-json",
      "--verbose",
    ])
  })

  it("omits resume and permission-mode when unset (first turn, default perms)", () => {
    expect(buildHeadlessArgs({ prompt: "hello" })).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
    ])
  })
})

describe("parseSdkLine", () => {
  it("returns SDK messages verbatim — fields untouched, extras preserved", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a" } }] },
      parent_tool_use_id: null,
      session_id: "sid-9",
      uuid: "extra-field-not-in-our-interface",
    })
    const msg = parseSdkLine(line)
    expect(msg).toEqual(JSON.parse(line))
  })

  it("captures result usage/cost fields as-is", () => {
    const msg = parseSdkLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 3210,
        total_cost_usd: 0.0512,
        usage: { input_tokens: 10, output_tokens: 42 },
        session_id: "sid-2",
      }),
    )
    expect(msg?.type).toBe("result")
    if (msg?.type === "result") {
      expect(msg.usage?.output_tokens).toBe(42)
      expect(msg.total_cost_usd).toBe(0.0512)
    }
  })

  it("drops blanks, non-JSON noise, and unknown top-level types", () => {
    expect(parseSdkLine("")).toBeUndefined()
    expect(parseSdkLine("   ")).toBeUndefined()
    expect(parseSdkLine("not json {")).toBeUndefined()
    expect(parseSdkLine('"a bare string"')).toBeUndefined()
    expect(parseSdkLine(JSON.stringify({ type: "keepalive" }))).toBeUndefined()
    expect(parseSdkLine(JSON.stringify([1, 2]))).toBeUndefined()
  })
})
