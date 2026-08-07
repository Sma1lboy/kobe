import { describe, expect, it } from "vitest"
import { type HistoryDeps, traceRevision } from "../../src/engine/codex-local/history.ts"
import { parseCodexTrace } from "../../src/engine/codex-local/trace-parse.ts"
import { MAX_JSONL_LINE_CHARS } from "../../src/engine/file-bounds.ts"

const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const T0 = Date.parse("2026-08-06T10:00:00.000Z")

function row(
  type: string,
  payload: Record<string, unknown>,
  offsetMs = 0,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    timestamp: new Date(T0 + offsetMs).toISOString(),
    payload,
    ...extra,
  })
}

function response(payload: Record<string, unknown>, offsetMs: number): string {
  return row("response_item", payload, offsetMs)
}

describe("parseCodexTrace", () => {
  it("keeps persisted turn, item, and call identities across a complete turn", () => {
    const raw = [
      row("event_msg", { type: "task_started", turn_id: "turn-1" }),
      row("turn_context", {}, 1, { turn_id: "turn-1" }),
      response(
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the auth race" }],
        },
        2,
      ),
      response(
        {
          id: "commentary-1",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "I will inspect the lock." }],
        },
        3,
      ),
      response(
        {
          type: "function_call",
          call_id: "call-1",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "rg lock src" }),
        },
        4,
      ),
      response(
        {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify({ output: "src/auth.ts", exit_code: 0 }),
        },
        8,
      ),
      response(
        {
          id: "answer-1",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "The race is fixed." }],
        },
        9,
      ),
      row("event_msg", { type: "task_complete", turn_id: "turn-1" }, 10),
    ].join("\n")

    const trace = parseCodexTrace(raw, SESSION_ID)
    expect(trace.sessionId).toBe(SESSION_ID)
    expect(trace.turns).toHaveLength(1)
    expect(trace.turns[0]).toMatchObject({
      id: "turn-1",
      title: "Fix the auth race",
      status: "success",
      startedAt: T0,
      endedAt: T0 + 10,
    })
    expect(trace.turns[0]?.nodes.map((node) => node.id)).toEqual(["commentary-1", "call-1", "answer-1"])
    expect(trace.turns[0]?.nodes[1]).toMatchObject({
      parentId: "commentary-1",
      parentBasis: "temporal",
      status: "success",
      title: "exec_command",
      summary: "rg lock src",
      endedAt: T0 + 8,
    })
    expect(trace.turns[0]?.nodes[1]?.resultDetail).toContain("src/auth.ts")
  })

  it("does not lose a temporal parent when the same turn marker is repeated", () => {
    const raw = [
      row("event_msg", { type: "task_started", turn_id: "turn-1" }),
      response(
        {
          id: "commentary-1",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Inspect first." }],
        },
        1,
      ),
      row("turn_context", {}, 2, { turn_id: "turn-1" }),
      response(
        {
          type: "custom_tool_call",
          call_id: "call-1",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
        3,
      ),
    ].join("\n")

    const turn = parseCodexTrace(raw, SESSION_ID).turns[0]
    expect(turn?.status).toBe("running")
    expect(turn?.nodes[1]).toMatchObject({
      id: "call-1",
      kind: "change",
      parentId: "commentary-1",
      parentBasis: "temporal",
      status: "running",
    })
  })

  it("pairs out-of-order results and keeps unrelated parallel calls as siblings", () => {
    const raw = [
      row("event_msg", { type: "task_started", turn_id: "turn-1" }),
      response(
        {
          id: "commentary-1",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Run both checks." }],
        },
        1,
      ),
      response(
        {
          type: "function_call_output",
          call_id: "early",
          output: JSON.stringify({ output: "failed", metadata: { exit_code: 2 } }),
        },
        5,
      ),
      response(
        {
          type: "function_call",
          call_id: "early",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "bun test one" }),
        },
        2,
      ),
      response(
        {
          type: "function_call",
          call_id: "still-live",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "bun test two" }),
        },
        3,
      ),
    ].join("\n")

    const nodes = parseCodexTrace(raw, SESSION_ID).turns[0]?.nodes ?? []
    expect(nodes.map((node) => node.parentId)).toEqual([null, "commentary-1", "commentary-1"])
    expect(nodes[1]).toMatchObject({ status: "error", endedAt: T0 + 5 })
    expect(nodes[2]).toMatchObject({ status: "running", endedAt: null })
  })

  it("degrades safely for failed, hosted, hidden, malformed, and oversize records", () => {
    const huge = "x".repeat(MAX_JSONL_LINE_CHARS + 1)
    const raw = [
      "{not-json",
      response(
        {
          id: "dropped",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: huge }],
        },
        0,
      ),
      row("event_msg", { type: "task_started", turn_id: "turn-failed" }, 1),
      response({ id: "secret", type: "reasoning", encrypted_content: "opaque" }, 2),
      response(
        {
          id: "web-1",
          type: "web_search_call",
          status: "completed",
          query: "Kobe Agent Trace",
        },
        3,
      ),
      row("event_msg", { type: "task_failed", turn_id: "turn-failed" }, 4),
    ].join("\n")

    const turn = parseCodexTrace(raw, SESSION_ID).turns[0]
    expect(turn?.status).toBe("error")
    expect(turn?.nodes).toHaveLength(1)
    expect(turn?.nodes[0]).toMatchObject({
      id: "web-1",
      kind: "tool",
      title: "web_search_call",
      status: "success",
    })
  })
})

describe("traceRevision", () => {
  it("retries a missing rollout and then reuses its immutable path", async () => {
    let present = false
    let rootReads = 0
    const filename = `rollout-2026-08-06T10-00-00-${SESSION_ID}.jsonl`
    const deps: HistoryDeps = {
      sessionsDir: () => "/sessions",
      readdir: async (path) => {
        if (path === "/sessions") {
          rootReads += 1
          return present ? ["2026"] : []
        }
        if (path === "/sessions/2026") return ["08"]
        if (path === "/sessions/2026/08") return ["06"]
        if (path === "/sessions/2026/08/06") return [filename]
        return []
      },
      readFile: async () => "",
      stat: async () => ({ mtimeMs: 123 }),
    }

    expect(await traceRevision(SESSION_ID, deps)).toBe(0)
    present = true
    expect(await traceRevision(SESSION_ID, deps)).toBe(123)
    expect(await traceRevision(SESSION_ID, deps)).toBe(123)
    expect(rootReads).toBe(2)
  })
})
