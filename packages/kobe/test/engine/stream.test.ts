/**
 * Unit tests for the stream-json normalizer.
 *
 * These tests assert on the shape of `EngineEvent` sequences emitted
 * for each kind of stream-json input. They are the only thing
 * preventing event-leak regressions: if someone changes the parser to
 * pass through a raw `tool_use` block, these tests fail.
 *
 * We feed the parser via `linesFrom(...)` which converts a string
 * array to an `AsyncIterable<string>`. No real subprocess, no real
 * I/O — pure function tests.
 */

import { parseStreamJson, readLines } from "@/engine/claude-code-local/stream"
import type { EngineEvent } from "@/types/engine"
import { describe, expect, it } from "vitest"

async function* linesFrom(arr: string[]): AsyncIterable<string> {
  for (const s of arr) yield s
}

async function collect(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

describe("parseStreamJson", () => {
  it("captures session id from system.init via onSessionId callback (no event emitted)", async () => {
    let captured: string | undefined
    const events = await collect(
      parseStreamJson(
        linesFrom([
          JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" }),
          JSON.stringify({ type: "result", subtype: "success" }),
        ]),
        {
          onSessionId: (sid) => {
            captured = sid
          },
        },
      ),
    )
    expect(captured).toBe("abc-123")
    // system.init must NOT show up as an EngineEvent — it's out-of-band.
    expect(events.map((e) => e.type)).toEqual(["done"])
  })

  it("maps assistant text blocks to assistant.delta in order", async () => {
    const events = await collect(
      parseStreamJson(
        linesFrom([
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "hello " }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "world" }] },
          }),
          JSON.stringify({ type: "result", subtype: "success" }),
        ]),
      ),
    )
    expect(events).toEqual([
      { type: "assistant.delta", text: "hello " },
      { type: "assistant.delta", text: "world" },
      { type: "done" },
    ])
  })

  it("maps tool_use blocks to tool.start and tool_result to tool.result with the tool name carried through", async () => {
    const events = await collect(
      parseStreamJson(
        linesFrom([
          JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "foo" } }],
            },
          }),
          JSON.stringify({
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }],
            },
          }),
          JSON.stringify({ type: "result", subtype: "success" }),
        ]),
      ),
    )
    expect(events).toEqual([
      { type: "tool.start", name: "Read", input: { path: "foo" } },
      { type: "tool.result", name: "Read", output: "file contents" },
      { type: "done" },
    ])
  })

  it("emits usage then done from a result success event", async () => {
    const events = await collect(
      parseStreamJson(
        linesFrom([
          JSON.stringify({
            type: "result",
            subtype: "success",
            usage: { input_tokens: 12, output_tokens: 34 },
          }),
        ]),
      ),
    )
    expect(events).toEqual([{ type: "usage", input_tokens: 12, output_tokens: 34 }, { type: "done" }])
  })

  it("emits error (not done) when result.subtype signals failure", async () => {
    const events = await collect(
      parseStreamJson(linesFrom([JSON.stringify({ type: "result", subtype: "error_max_turns" })])),
    )
    expect(events).toEqual([{ type: "error", message: "claude session ended: error_max_turns" }])
  })

  it("yields a parse-error event for malformed JSON but keeps consuming", async () => {
    const events = await collect(
      parseStreamJson(
        linesFrom([
          "{not valid json",
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "after bad line" }] },
          }),
          JSON.stringify({ type: "result", subtype: "success" }),
        ]),
      ),
    )
    expect(events[0]?.type).toBe("error")
    expect(events.slice(1)).toEqual([{ type: "assistant.delta", text: "after bad line" }, { type: "done" }])
  })

  it("ignores blank lines and unknown top-level types", async () => {
    const events = await collect(
      parseStreamJson(
        linesFrom([
          "",
          "   ",
          JSON.stringify({ type: "future_unknown_event", payload: 42 }),
          JSON.stringify({ type: "result", subtype: "success" }),
        ]),
      ),
    )
    expect(events).toEqual([{ type: "done" }])
  })

  it("handles bare top-level content array (no inner message wrapper)", async () => {
    // Some claude versions emit `{ type: "assistant", content: [...] }`
    // directly — our extractor accepts both shapes.
    const events = await collect(
      parseStreamJson(
        linesFrom([
          JSON.stringify({
            type: "assistant",
            content: [{ type: "text", text: "bare" }],
          }),
          JSON.stringify({ type: "result", subtype: "success" }),
        ]),
      ),
    )
    expect(events).toEqual([{ type: "assistant.delta", text: "bare" }, { type: "done" }])
  })
})

describe("readLines", () => {
  it("buffers chunked input into complete lines", async () => {
    async function* chunks() {
      yield "first"
      yield " line\nsecond"
      yield " line\n"
      yield "third"
    }
    const out: string[] = []
    for await (const line of readLines(chunks())) out.push(line)
    expect(out).toEqual(["first line", "second line", "third"])
  })

  it("accepts Buffer chunks and decodes as utf8", async () => {
    async function* chunks() {
      yield Buffer.from("a\nb\n", "utf8")
    }
    const out: string[] = []
    for await (const line of readLines(chunks())) out.push(line)
    expect(out).toEqual(["a", "b"])
  })
})
