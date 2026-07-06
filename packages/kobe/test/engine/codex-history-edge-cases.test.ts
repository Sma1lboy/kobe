import { mkdir, mkdtemp, readFile as readFileReal, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  type HistoryDeps,
  deleteHistory,
  parseJsonl,
  readHistory,
  readHistoryWithMetrics,
  rolloutCwd,
} from "../../src/engine/codex-local/history.ts"

const SID = "aaaaaaaa-1111-2222-3333-444444444444"

describe("rolloutCwd", () => {
  it("reads cwd off the first session_meta line", () => {
    const raw = JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/work/tree" } })
    expect(rolloutCwd(raw)).toBe("/work/tree")
  })

  it("returns '' when session_meta has no cwd", () => {
    const raw = JSON.stringify({ type: "session_meta", payload: { id: "x" } })
    expect(rolloutCwd(raw)).toBe("")
  })

  it("returns '' when the first record isn't session_meta", () => {
    const raw = JSON.stringify({ type: "response_item", payload: {} })
    expect(rolloutCwd(raw)).toBe("")
  })

  it("returns '' for a blank file", () => {
    expect(rolloutCwd("")).toBe("")
    expect(rolloutCwd("\n\n")).toBe("")
  })

  it("tolerates a malformed FIRST line without throwing, but still stops there (no meta)", () => {
    const raw = ["{not json", JSON.stringify({ type: "session_meta", payload: { cwd: "/wt" } })].join("\n")
    expect(rolloutCwd(raw)).toBe("")
  })

  it("treats an oversize leading line as unparseable", () => {
    const megaLine = "x".repeat(9 * 1024 * 1024)
    expect(rolloutCwd(megaLine)).toBe("")
  })
})

describe("parseJsonl — message records", () => {
  const meta = (payload: Record<string, unknown>, timestamp = "2026-01-01T00:00:00Z") =>
    JSON.stringify({ type: "response_item", timestamp, payload })

  it("keeps user/assistant/system messages and drops unknown roles", () => {
    const raw = [
      meta({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }),
      meta({ type: "message", role: "assistant", content: [{ type: "output_text", text: "yo" }] }),
      meta({ type: "message", role: "system", content: "sys note" }),
      meta({ type: "message", role: "tool", content: "nope" }),
    ].join("\n")
    const out = parseJsonl(raw, SID)
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "system"])
    expect(out[0]?.blocks).toEqual([{ type: "text", text: "hi" }])
    expect(out.every((m) => m.sessionId === SID)).toBe(true)
  })

  it("drops Codex's synthetic environment_context user row", () => {
    const raw = meta({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }],
    })
    expect(parseJsonl(raw, SID)).toEqual([])
  })

  it("falls back to now() when the record has no timestamp string", () => {
    const raw = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: "hi" },
    })
    const out = parseJsonl(raw, SID)
    expect(out).toHaveLength(1)
    expect(() => new Date(out[0]!.timestamp).toISOString()).not.toThrow()
  })

  it("skips blank lines, non-JSON lines, non-response_item types, and missing payload", () => {
    const raw = [
      "",
      "   ",
      "{not json",
      JSON.stringify({ type: "turn_context" }),
      JSON.stringify({ type: "response_item" }),
      meta({ type: "message", role: "user", content: "ok" }),
    ].join("\n")
    expect(parseJsonl(raw, SID)).toHaveLength(1)
  })

  it("skips a line past the JSONL length bound", () => {
    const hugeText = "x".repeat(9 * 1024 * 1024)
    const raw = meta({ type: "message", role: "user", content: hugeText })
    expect(parseJsonl(raw, SID)).toEqual([])
  })
})

describe("parseJsonl — reasoning records", () => {
  const meta = (payload: Record<string, unknown>) =>
    JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:00Z", payload })

  it("maps reasoning.text to a thinking block", () => {
    const raw = meta({ type: "reasoning", text: "thinking hard" })
    expect(parseJsonl(raw, SID)).toEqual([
      {
        role: "assistant",
        blocks: [{ type: "thinking", text: "thinking hard" }],
        timestamp: "2026-01-01T00:00:00Z",
        sessionId: SID,
      },
    ])
  })

  it("falls back to reasoning.summary array when content/text are absent", () => {
    const raw = meta({ type: "reasoning", summary: [{ text: "part1" }, "part2"] })
    const out = parseJsonl(raw, SID)
    expect(out[0]?.blocks).toEqual([{ type: "thinking", text: "part1part2" }])
  })

  it("drops a reasoning record with no extractable text", () => {
    const raw = meta({ type: "reasoning" })
    expect(parseJsonl(raw, SID)).toEqual([])
  })
})

describe("parseJsonl — tool call / result records", () => {
  const meta = (payload: Record<string, unknown>) =>
    JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:00Z", payload })

  it("normalizes function_call with JSON-string arguments", () => {
    const raw = meta({ type: "function_call", call_id: "c1", name: "shell", arguments: '{"cmd":"ls"}' })
    const out = parseJsonl(raw, SID)
    expect(out).toEqual([
      {
        role: "assistant",
        blocks: [{ type: "tool_call", callId: "c1", name: "shell", input: { cmd: "ls" } }],
        timestamp: "2026-01-01T00:00:00Z",
        sessionId: SID,
      },
    ])
  })

  it("keeps arguments as-is when they aren't valid JSON", () => {
    const raw = meta({ type: "function_call", call_id: "c1", name: "shell", arguments: "not json" })
    const out = parseJsonl(raw, SID)
    expect(out[0]?.blocks).toEqual([{ type: "tool_call", callId: "c1", name: "shell", input: "not json" }])
  })

  it("drops a function_call with no call_id", () => {
    const raw = meta({ type: "function_call", name: "shell", arguments: "{}" })
    expect(parseJsonl(raw, SID)).toEqual([])
  })

  it("normalizes custom_tool_call using payload.input", () => {
    const raw = meta({ type: "custom_tool_call", call_id: "c2", name: "custom", input: '{"a":1}' })
    const out = parseJsonl(raw, SID)
    expect(out[0]?.blocks).toEqual([{ type: "tool_call", callId: "c2", name: "custom", input: { a: 1 } }])
  })

  it("normalizes tool_search_call with a name fallback and stripped payload", () => {
    const raw = meta({ type: "tool_search_call", call_id: "c3", status: "ok", query: "grep foo" })
    const out = parseJsonl(raw, SID)
    expect(out[0]?.blocks).toEqual([
      { type: "tool_call", callId: "c3", name: "tool_search_call", input: { query: "grep foo" } },
    ])
  })

  it("normalizes function_call_output as a user-role tool_result", () => {
    const raw = meta({ type: "function_call_output", call_id: "c1", output: '{"ok":true}' })
    const out = parseJsonl(raw, SID)
    expect(out).toEqual([
      {
        role: "user",
        blocks: [{ type: "tool_result", callId: "c1", output: { ok: true }, isError: false }],
        timestamp: "2026-01-01T00:00:00Z",
        sessionId: SID,
      },
    ])
  })

  it("normalizes custom_tool_call_output", () => {
    const raw = meta({ type: "custom_tool_call_output", call_id: "c2", output: "plain text" })
    const out = parseJsonl(raw, SID)
    expect(out[0]?.blocks).toEqual([{ type: "tool_result", callId: "c2", output: "plain text", isError: false }])
  })

  it("normalizes tool_search_output with stripped payload", () => {
    const raw = meta({ type: "tool_search_output", call_id: "c3", results: ["a.ts"] })
    const out = parseJsonl(raw, SID)
    expect(out[0]?.blocks).toEqual([
      { type: "tool_result", callId: "c3", output: { results: ["a.ts"] }, isError: false },
    ])
  })

  it("drops a *_output record with no call_id", () => {
    const raw = meta({ type: "function_call_output", output: "x" })
    expect(parseJsonl(raw, SID)).toEqual([])
  })

  it("normalizes web_search_call / image_generation_call / local_shell_call as a paired tool_call+tool_result", () => {
    for (const type of ["web_search_call", "image_generation_call", "local_shell_call"]) {
      const raw = meta({ type, call_id: `c-${type}`, query: "x" })
      const out = parseJsonl(raw, SID)
      expect(out).toHaveLength(1)
      expect(out[0]?.blocks).toEqual([
        { type: "tool_call", callId: `c-${type}`, name: type, input: { query: "x" } },
        { type: "tool_result", callId: `c-${type}`, output: { query: "x" }, isError: false },
      ])
    }
  })

  it("synthesizes a call_id for a single-record tool when none is given", () => {
    const raw = meta({ type: "web_search_call", query: "x" })
    const out = parseJsonl(raw, SID)
    const callId = (out[0]?.blocks[0] as { callId: string }).callId
    expect(callId).toBe("web_search_call:2026-01-01T00:00:00Z")
  })

  it("drops an unrecognized response_item type", () => {
    const raw = meta({ type: "something_new" })
    expect(parseJsonl(raw, SID)).toEqual([])
  })
})

describe("readHistoryWithMetrics / readHistory", () => {
  function deps(over: Partial<HistoryDeps> = {}): HistoryDeps {
    return {
      sessionsDir: () => "/sessions",
      readdir: async () => [],
      readFile: async () => "",
      stat: async () => ({ mtimeMs: 0 }),
      ...over,
    }
  }

  it("returns empty messages when no rollout matches the session id", async () => {
    expect(await readHistoryWithMetrics("missing", deps())).toEqual({ messages: [] })
    expect(await readHistory("missing", deps())).toEqual([])
  })

  it("returns empty messages when the matched file can't be read", async () => {
    const rollout = "rollout-2026-01-01T00-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl"
    const d = deps({
      readdir: async (p) => {
        if (p === "/sessions") return ["2026"]
        if (p === "/sessions/2026") return ["01"]
        if (p === "/sessions/2026/01") return ["01"]
        if (p === "/sessions/2026/01/01") return [rollout]
        return []
      },
      readFile: async () => {
        throw new Error("EACCES")
      },
    })
    expect(await readHistoryWithMetrics(SID, d)).toEqual({ messages: [] })
  })

  it("parses messages, sorts by timestamp, and attaches derived usage metrics", async () => {
    const rollout = "rollout-2026-01-01T00-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl"
    const lines = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:02Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "second" }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 7 } }),
    ]
    const d = deps({
      readdir: async (p) => {
        if (p === "/sessions") return ["2026"]
        if (p === "/sessions/2026") return ["01"]
        if (p === "/sessions/2026/01") return ["01"]
        if (p === "/sessions/2026/01/01") return [rollout]
        return []
      },
      readFile: async () => lines.join("\n"),
    })
    const result = await readHistoryWithMetrics(SID, d)
    expect(result.messages.map((m) => (m.blocks[0] as { text: string }).text)).toEqual(["first", "second"])
    expect(result.usageMetrics).toEqual({ input_tokens: 0, output_tokens: 7 })
  })
})

describe("deleteHistory (real temp rollout tree)", () => {
  let tmpRoot: string

  afterEach(async () => {
    if (tmpRoot) await import("node:fs/promises").then((fs) => fs.rm(tmpRoot, { recursive: true, force: true }))
  })

  async function realDeps(): Promise<{ deps: HistoryDeps; file: string }> {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "kobe-codex-sessions-"))
    const dayDir = path.join(tmpRoot, "2026", "01", "01")
    await mkdir(dayDir, { recursive: true })
    const fname = `rollout-2026-01-01T00-00-00-${SID}.jsonl`
    const file = path.join(dayDir, fname)
    await writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id: SID, cwd: "/wt" } })}\n`)
    const { readdir: realReaddir } = await import("node:fs/promises")
    const deps: HistoryDeps = {
      sessionsDir: () => tmpRoot,
      readdir: async (p) => {
        try {
          return await realReaddir(p)
        } catch {
          return []
        }
      },
      readFile: async (p) => readFileReal(p, "utf8"),
      stat: async (p) => (await import("node:fs/promises")).stat(p),
    }
    return { deps, file }
  }

  it("unlinks the matched rollout file", async () => {
    const { deps, file } = await realDeps()
    await deleteHistory(SID, deps)
    await expect(readFileReal(file, "utf8")).rejects.toThrow()
  })

  it("is a no-op (does not throw) for a session id with no matching rollout", async () => {
    const { deps } = await realDeps()
    await expect(deleteHistory("00000000-0000-0000-0000-000000000000", deps)).resolves.toBeUndefined()
  })
})
