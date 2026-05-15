import { parseStreamJson } from "@/engine/gemini-local/stream"
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

describe("gemini stream parser", () => {
  it("captures session id from init and streams assistant deltas", async () => {
    const ids: string[] = []
    const events = await collect(
      [
        JSON.stringify({ type: "init", session_id: "gemini-session", model: "gemini-2.5-pro" }),
        JSON.stringify({ type: "message", role: "user", content: "hello" }),
        JSON.stringify({ type: "message", role: "assistant", content: "hi", delta: true }),
        JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 2 } }),
      ],
      (id) => ids.push(id),
    )

    expect(ids).toEqual(["gemini-session"])
    expect(events).toEqual([
      { type: "assistant.delta", text: "hi" },
      { type: "usage", input_tokens: 10, output_tokens: 2 },
      { type: "done" },
    ])
  })

  it("normalizes tool use/result pairs", async () => {
    const events = await collect([
      JSON.stringify({ type: "tool_use", tool_id: "call-1", tool_name: "read_file", parameters: { path: "a.ts" } }),
      JSON.stringify({ type: "tool_result", tool_id: "call-1", status: "success", output: "contents" }),
      JSON.stringify({ type: "result", status: "success", stats: {} }),
    ])

    expect(events.slice(0, 2)).toEqual([
      { type: "tool.start", name: "read_file", input: { path: "a.ts" } },
      { type: "tool.result", name: "read_file", output: "contents" },
    ])
  })

  it("treats fatal stream errors as terminal", async () => {
    const events = await collect([JSON.stringify({ type: "error", severity: "error", message: "auth failed" })])

    expect(events).toEqual([{ type: "error", message: "auth failed" }])
  })
})
