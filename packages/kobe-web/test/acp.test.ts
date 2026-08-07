import { describe, expect, test } from "vitest"
import { type AcpItem, applyAcpUpdate } from "../src/lib/acp.ts"

describe("applyAcpUpdate", () => {
  test("streams chunks into aggregated messages", () => {
    let items: AcpItem[] = []
    items = applyAcpUpdate(items, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hi" },
    })
    items = applyAcpUpdate(items, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "po" },
    })
    items = applyAcpUpdate(items, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ng" },
    })
    expect(items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "pong" },
    ])
  })

  test("tool calls patch in place and plans replace", () => {
    let items: AcpItem[] = []
    items = applyAcpUpdate(items, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read file",
      status: "pending",
    })
    items = applyAcpUpdate(items, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    })
    items = applyAcpUpdate(items, {
      sessionUpdate: "plan",
      entries: [{ content: "step 1", status: "pending" }],
    })
    items = applyAcpUpdate(items, {
      sessionUpdate: "plan",
      entries: [{ content: "step 1", status: "completed" }],
    })
    expect(items).toEqual([
      { kind: "tool", id: "t1", title: "Read file", status: "completed" },
      { kind: "plan", entries: [{ content: "step 1", status: "completed" }] },
    ])
  })

  test("unknown updates are ignored", () => {
    const items = applyAcpUpdate([], { sessionUpdate: "future_thing" })
    expect(items).toEqual([])
  })
})
