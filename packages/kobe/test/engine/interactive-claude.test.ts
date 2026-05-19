/**
 * Unit tests for the KOB-208 interactive-claude engine's pure pieces:
 * the transcript-record → EngineEvent mapper, and the incremental
 * JSONL tail.
 *
 * Why these matter — the interactive engine renders the conversation
 * entirely by tailing the transcript JSONL (there is no stream-json
 * protocol). If the tail drops a record, mishandles a partial trailing
 * line, or the mapper mis-reads `stop_reason`, the chat either stalls
 * forever or renders nothing. These tests pin both.
 *
 * The PTY host + `HostClient` are deliberately not unit-tested here —
 * they require a real Node child + `node-pty` + a real `claude`; that
 * path is exercised end to end by `scripts/interactive-claude-e2e.ts`.
 */

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordToEvents } from "@/engine/interactive-claude/events"
import { TranscriptTail } from "@/engine/interactive-claude/transcript-tail"
import { describe, expect, it } from "vitest"

describe("recordToEvents", () => {
  it("maps an assistant text record to assistant.delta + done signal", () => {
    const mapped = recordToEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello world" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    })
    expect(mapped.role).toBe("assistant")
    expect(mapped.stopReason).toBe("end_turn")
    expect(mapped.events).toContainEqual({ type: "assistant.delta", text: "hello world" })
    expect(mapped.events).toContainEqual({ type: "usage", input_tokens: 10, output_tokens: 4 })
  })

  it("keeps a tool_use turn open (stop_reason tool_use is not terminal)", () => {
    const mapped = recordToEvents({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file: "x" } }],
        stop_reason: "tool_use",
      },
    })
    expect(mapped.stopReason).toBe("tool_use")
    expect(mapped.events).toContainEqual({ type: "tool.start", name: "Read", input: { file: "x" }, id: "t1" })
  })

  it("surfaces tool_result blocks on user records but not user prose", () => {
    const result = recordToEvents({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    })
    expect(result.events).toContainEqual({ type: "tool.result", name: "tool", output: "ok" })

    const prose = recordToEvents({
      type: "user",
      message: { role: "user", content: "what the user typed" },
    })
    expect(prose.events).toEqual([])
  })

  it("drops subagent sidechain records", () => {
    const mapped = recordToEvents({
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "subagent prose" }] },
    })
    expect(mapped.events).toEqual([])
  })
})

describe("TranscriptTail", () => {
  function tmpFile(): string {
    return path.join(mkdtempSync(path.join(tmpdir(), "kobe-tail-")), "session.jsonl")
  }

  it("emits only records appended after the start offset", async () => {
    const file = tmpFile()
    const before = `${JSON.stringify({ type: "summary", text: "old" })}\n`
    writeFileSync(file, before)

    const seen: Record<string, unknown>[] = []
    const tail = new TranscriptTail({
      filePath: file,
      startOffset: Buffer.byteLength(before),
      onRecord: (r) => seen.push(r),
    })

    appendFileSync(file, `${JSON.stringify({ type: "assistant", message: { role: "assistant" } })}\n`)
    await tail.drainNow()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe("assistant")
  })

  it("waits for a partial trailing line to complete before emitting it", async () => {
    const file = tmpFile()
    writeFileSync(file, "")
    const seen: Record<string, unknown>[] = []
    const tail = new TranscriptTail({ filePath: file, startOffset: 0, onRecord: (r) => seen.push(r) })

    // A record written without its trailing newline yet.
    const record = JSON.stringify({ type: "assistant", message: { role: "assistant" } })
    appendFileSync(file, record)
    await tail.drainNow()
    expect(seen).toHaveLength(0) // no complete line yet

    appendFileSync(file, "\n")
    await tail.drainNow()
    expect(seen).toHaveLength(1)
  })

  it("is a no-op when the file does not exist yet", async () => {
    const tail = new TranscriptTail({
      filePath: path.join(tmpdir(), "kobe-tail-missing", "nope.jsonl"),
      startOffset: 0,
      onRecord: () => {
        throw new Error("should not be called")
      },
    })
    await expect(tail.drainNow()).resolves.toBeUndefined()
  })
})
