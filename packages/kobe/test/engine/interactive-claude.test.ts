/**
 * Unit tests for the KOB-208 interactive-claude engine.
 *
 * Covers the pure pieces (the transcript-record → EngineEvent mapper,
 * the incremental JSONL tail) and the engine's turn-completion logic
 * driven through a fake PTY host + a real temp transcript file.
 *
 * Why these matter — the interactive engine renders the conversation
 * entirely by tailing the transcript JSONL (there is no stream-json
 * protocol). If the tail drops a record, mishandles a partial trailing
 * line, the mapper mis-reads `stop_reason`, or the engine closes a turn
 * before the visible reply lands, the chat either stalls forever or
 * renders nothing.
 *
 * The PTY host itself (`pty-host.cjs`) is not unit-tested here — it
 * needs a real Node child + `node-pty` + `claude`; that path is
 * exercised end to end by `scripts/interactive-claude-e2e.ts`.
 */

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { recordToEvents } from "@/engine/interactive-claude/events"
import type { HostEvent, HostStartOpts, InteractiveHost } from "@/engine/interactive-claude/host-client"
import { InteractiveClaudeEngine } from "@/engine/interactive-claude/index"
import { TranscriptTail } from "@/engine/interactive-claude/transcript-tail"
import type { EngineEvent } from "@/types/engine"
import { describe, expect, it } from "vitest"

/**
 * A fake PTY host: no Node child, no `claude`. It reports a fixed
 * session pointing at a test-controlled transcript file; the test
 * drives the conversation by writing JSONL records to that file, which
 * the engine's real {@link TranscriptTail} then picks up.
 */
class FakeHost implements InteractiveHost {
  alive = true
  readonly prompts: string[] = []
  constructor(
    private readonly sessionId: string,
    private readonly jsonlPath: string,
  ) {}
  on(_listener: (ev: HostEvent) => void): () => void {
    return () => {}
  }
  async onSession(): Promise<{ sessionId: string; jsonlPath: string }> {
    return { sessionId: this.sessionId, jsonlPath: this.jsonlPath }
  }
  isAlive(): boolean {
    return this.alive
  }
  async start(_opts: HostStartOpts): Promise<void> {}
  sendPrompt(text: string): void {
    this.prompts.push(text)
  }
  stop(): void {
    this.alive = false
  }
}

/** A complete assistant message split into one record per content block. */
function assistantBlockRecord(block: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [block],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 9 },
    },
  })
}

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

describe("InteractiveClaudeEngine turn completion", () => {
  function setup() {
    const dir = mkdtempSync(path.join(tmpdir(), "kobe-iclaude-"))
    const jsonlPath = path.join(dir, "session.jsonl")
    writeFileSync(jsonlPath, "")
    const host = new FakeHost("test-session", jsonlPath)
    const engine = new InteractiveClaudeEngine({
      binaryPathResolver: async () => "/fake/claude",
      hostFactory: () => host,
      settleMs: 120,
      quietMs: 4000,
      noResponseMs: 4000,
    })
    return { engine, host, jsonlPath }
  }

  async function collect(engine: InteractiveClaudeEngine, handle: { sessionId: string; cwd: string }) {
    const events: EngineEvent[] = []
    for await (const ev of engine.stream(handle)) events.push(ev)
    return events
  }

  it("does NOT close the turn on the thinking record — the later text record still renders", async () => {
    // The KOB-208 regression: claude-code persists one record per
    // content block. A `thinking` record and the `text` record of the
    // SAME message both carry `stop_reason: end_turn`. Closing on the
    // first one dropped the visible reply (observed in the TUI: user
    // rows shown, zero assistant rows).
    const { engine, host, jsonlPath } = setup()
    const handle = await engine.spawn("/repo", "hi")

    appendFileSync(jsonlPath, `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`)
    appendFileSync(jsonlPath, `${assistantBlockRecord({ type: "thinking", thinking: "pondering" })}\n`)
    appendFileSync(
      jsonlPath,
      `${assistantBlockRecord({ type: "text", text: "Hi! What would you like to work on?" })}\n`,
    )

    const events = await collect(engine, handle)
    const text = events
      .filter((e): e is Extract<EngineEvent, { type: "assistant.delta" }> => e.type === "assistant.delta")
      .map((e) => e.text)
      .join("")
    expect(text).toBe("Hi! What would you like to work on?")
    expect(events.at(-1)?.type).toBe("done")
    expect(host.prompts).toEqual(["hi"])
  })

  it("renders a single-block reply (no thinking) and completes", async () => {
    const { engine, jsonlPath } = setup()
    const handle = await engine.spawn("/repo", "ping")
    appendFileSync(jsonlPath, `${assistantBlockRecord({ type: "text", text: "pong" })}\n`)

    const events = await collect(engine, handle)
    expect(events.some((e) => e.type === "assistant.delta" && e.text === "pong")).toBe(true)
    expect(events.some((e) => e.type === "usage")).toBe(true)
    expect(events.at(-1)?.type).toBe("done")
  })
})
