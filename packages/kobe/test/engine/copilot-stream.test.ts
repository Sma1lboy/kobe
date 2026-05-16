import { parseStreamJson } from "@/engine/copilot-local/stream"
import type { EngineEvent } from "@/types/engine"
import { describe, expect, it } from "vitest"

async function collect(lines: readonly string[], onSessionId: (sessionId: string) => void = () => {}) {
  const events: EngineEvent[] = []
  for await (const ev of parseStreamJson(lineSource(lines), { onSessionId })) events.push(ev)
  return events
}

async function* lineSource(lines: readonly string[]) {
  for (const line of lines) yield line
}

describe("copilot stream parser", () => {
  it("captures session id and streams assistant deltas without duplicating final message", async () => {
    const ids: string[] = []
    const events = await collect(
      [
        JSON.stringify({ type: "session.start", data: { sessionId: "copilot-session" } }),
        JSON.stringify({ type: "assistant.message_start", data: { messageId: "m1" } }),
        JSON.stringify({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "OK" } }),
        JSON.stringify({ type: "assistant.message", data: { messageId: "m1", content: "OK", toolRequests: [] } }),
        JSON.stringify({ type: "result", sessionId: "copilot-session", exitCode: 0, usage: {} }),
      ],
      (id) => ids.push(id),
    )

    expect(ids).toEqual(["copilot-session", "copilot-session"])
    expect(events).toEqual([{ type: "assistant.delta", text: "OK" }, { type: "done" }])
  })

  it("normalizes tool execution pairs", async () => {
    const events = await collect([
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "call-1", toolName: "shell", arguments: [{ command: "git status" }] },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "call-1", success: true, result: { content: "clean" } },
      }),
      JSON.stringify({ type: "result", sessionId: "s", exitCode: 0 }),
    ])

    expect(events.slice(0, 2)).toEqual([
      { type: "tool.start", name: "shell", input: { command: "git status" } },
      { type: "tool.result", name: "shell", output: { content: "clean" } },
    ])
  })

  it("does not duplicate complete reasoning after streamed reasoning deltas", async () => {
    const events = await collect([
      JSON.stringify({ type: "assistant.reasoning_delta", data: { reasoningId: "r1", deltaContent: "checking " } }),
      JSON.stringify({ type: "assistant.reasoning_delta", data: { reasoningId: "r1", deltaContent: "the code" } }),
      JSON.stringify({ type: "assistant.reasoning", data: { reasoningId: "r1", content: "checking the code" } }),
      JSON.stringify({ type: "result", sessionId: "s", exitCode: 0 }),
    ])

    expect(events).toEqual([
      { type: "reasoning.delta", text: "checking " },
      { type: "reasoning.delta", text: "the code" },
      { type: "done" },
    ])
  })

  it("deduplicates reasoning by content when reasoning ids are absent", async () => {
    const events = await collect([
      JSON.stringify({ type: "assistant.reasoning_delta", data: { deltaContent: "checking " } }),
      JSON.stringify({ type: "assistant.reasoning_delta", data: { deltaContent: "the code" } }),
      JSON.stringify({ type: "assistant.reasoning", data: { content: "checking the code" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "done", reasoningText: "checking the code" } }),
      JSON.stringify({ type: "result", sessionId: "s", exitCode: 0 }),
    ])

    expect(events).toEqual([
      { type: "reasoning.delta", text: "checking " },
      { type: "reasoning.delta", text: "the code" },
      { type: "assistant.delta", text: "done" },
      { type: "done" },
    ])
  })

  it("streams reasoning text from complete assistant messages when no reasoning event exists", async () => {
    const events = await collect([
      JSON.stringify({ type: "assistant.message", data: { content: "done", reasoningText: "checked history" } }),
      JSON.stringify({ type: "result", sessionId: "s", exitCode: 0 }),
    ])

    expect(events).toEqual([
      { type: "reasoning.delta", text: "checked history" },
      { type: "assistant.delta", text: "done" },
      { type: "done" },
    ])
  })

  it("deduplicates tool starts repeated across assistant messages and execution events", async () => {
    const events = await collect([
      JSON.stringify({
        type: "assistant.message",
        data: {
          messageId: "m1",
          content: "",
          toolRequests: [{ id: "call-1", name: "shell", arguments: [{ command: "git status" }] }],
        },
      }),
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "call-1", toolName: "shell", arguments: [{ command: "git status" }] },
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId: "call-1", success: true, result: { content: "clean" } },
      }),
      JSON.stringify({ type: "result", sessionId: "s", exitCode: 0 }),
    ])

    expect(events.filter((event) => event.type === "tool.start")).toEqual([
      { type: "tool.start", name: "shell", input: { command: "git status" } },
    ])
  })

  it("turns non-zero results into terminal errors", async () => {
    const events = await collect([JSON.stringify({ type: "result", sessionId: "s", exitCode: 1 })])

    expect(events).toEqual([{ type: "error", message: "copilot exited with code 1" }])
  })
})
