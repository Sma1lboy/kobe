import { describe, expect, it } from "vitest"
import type { Message } from "../../src/types/engine.ts"
import { traceFromHistory } from "../../src/engine/trace-from-history.ts"

const SESSION_ID = "compat-session"

function message(
  role: Message["role"],
  timestamp: string,
  blocks: Message["blocks"],
  phase?: Message["phase"],
): Message {
  return { role, timestamp, blocks, sessionId: SESSION_ID, phase }
}

describe("traceFromHistory", () => {
  it("normalizes a compatibility trace without claiming explicit causality", () => {
    const trace = traceFromHistory(SESSION_ID, [
      message("user", "2026-08-06T10:00:00.000Z", [{ type: "text", text: "Fix the auth race" }]),
      message(
        "assistant",
        "2026-08-06T10:00:01.000Z",
        [{ type: "text", text: "I will inspect the lock." }],
        "commentary",
      ),
      message("assistant", "2026-08-06T10:00:02.000Z", [
        {
          type: "tool_call",
          callId: "call-1",
          name: "exec_command",
          input: { cmd: "rg lock src" },
        },
      ]),
      message("user", "2026-08-06T10:00:03.000Z", [
        {
          type: "tool_result",
          callId: "call-1",
          output: "src/auth.ts",
          isError: false,
        },
      ]),
      message("assistant", "2026-08-06T10:00:04.000Z", [{ type: "text", text: "The race is fixed." }], "final"),
    ])

    expect(trace.turns).toHaveLength(1)
    expect(trace.turns[0]?.nodes.map((node) => node.kind)).toEqual(["commentary", "tool", "answer"])
    expect(trace.turns[0]?.nodes[1]).toMatchObject({
      id: "call-1",
      parentId: trace.turns[0]?.nodes[0]?.id,
      parentBasis: "temporal",
      status: "success",
      resultDetail: "src/auth.ts",
    })
  })

  it("keeps a failed result in the same fallback session turn", () => {
    const trace = traceFromHistory(SESSION_ID, [
      message("assistant", "2026-08-06T10:00:00.000Z", [
        { type: "tool_call", callId: "failed", name: "shell", input: {} },
      ]),
      message("user", "2026-08-06T10:00:01.000Z", [
        {
          type: "tool_result",
          callId: "failed",
          output: "boom",
          isError: true,
        },
      ]),
    ])

    expect(trace.turns[0]).toMatchObject({
      title: "Session activity",
      status: "error",
    })
    expect(trace.turns[0]?.nodes[0]).toMatchObject({
      parentId: null,
      parentBasis: "none",
      status: "error",
    })
  })

  it("bounds tool details before they cross the engine boundary", () => {
    const trace = traceFromHistory(SESSION_ID, [
      message("assistant", "2026-08-06T10:00:00.000Z", [
        {
          type: "tool_call",
          callId: "huge",
          name: "shell",
          input: { output: "x".repeat(110_000) },
        },
      ]),
    ])

    const detail = trace.turns[0]?.nodes[0]?.detail ?? ""
    expect(detail.length).toBeLessThan(101_000)
    expect(detail).toContain("truncated for display")
  })
})
