import { describe, expect, it } from "vitest"
import {
  type CopilotHistoryDeps,
  deleteHistory,
  findSessionDir,
  latestTranscriptMtimeForWorktree,
  listSessionDirs,
  parseEvents,
  readHistory,
  readHistoryWithMetrics,
  readWorkspace,
} from "../../src/engine/copilot-local/history.ts"

function deps(over: Partial<CopilotHistoryDeps> = {}): CopilotHistoryDeps {
  return {
    copilotDir: () => "/home/.copilot",
    readdir: async () => [],
    readFile: async () => {
      throw new Error("ENOENT")
    },
    stat: async () => ({ mtimeMs: 0 }),
    rm: async () => {},
    ...over,
  }
}

describe("listSessionDirs", () => {
  it("joins session-state entries under copilotDir", async () => {
    const d = deps({ readdir: async (p) => (p.endsWith("session-state") ? ["a", "b"] : []) })
    expect(await listSessionDirs(d)).toEqual(["/home/.copilot/session-state/a", "/home/.copilot/session-state/b"])
  })
})

describe("latestTranscriptMtimeForWorktree", () => {
  it("returns 0 for an empty worktree without scanning", async () => {
    expect(await latestTranscriptMtimeForWorktree("", deps())).toBe(0)
  })

  it("returns the newest matching session's events.jsonl mtime", async () => {
    const d = deps({
      readdir: async (p) => (p.endsWith("session-state") ? ["s1", "s2"] : []),
      readFile: async (p) => {
        if (p.endsWith("s1/workspace.yaml")) return "cwd: /wt\n"
        if (p.endsWith("s2/workspace.yaml")) return "cwd: /wt\n"
        throw new Error("missing")
      },
      stat: async (p) => ({ mtimeMs: p.includes("/s1/") ? 100 : 500 }),
    })
    expect(await latestTranscriptMtimeForWorktree("/wt", d)).toBe(500)
  })

  it("skips a session dir whose events.jsonl stat fails", async () => {
    const d = deps({
      readdir: async (p) => (p.endsWith("session-state") ? ["s1"] : []),
      readFile: async (p) => (p.endsWith("workspace.yaml") ? "cwd: /wt\n" : ""),
      stat: async () => {
        throw new Error("ENOENT")
      },
    })
    expect(await latestTranscriptMtimeForWorktree("/wt", d)).toBe(0)
  })
})

describe("readWorkspace / findSessionDir", () => {
  it("readWorkspace degrades to {} when workspace.yaml is unreadable", async () => {
    expect(await readWorkspace("/x/dir", deps())).toEqual({})
  })

  it("findSessionDir matches by directory basename", async () => {
    const d = deps({ readdir: async (p) => (p.endsWith("session-state") ? ["sess-1"] : []) })
    expect(await findSessionDir("sess-1", d)).toBe("/home/.copilot/session-state/sess-1")
  })

  it("findSessionDir matches by workspace id or name (case-insensitive)", async () => {
    const d = deps({
      readdir: async (p) => (p.endsWith("session-state") ? ["dir-a"] : []),
      readFile: async (p) => (p.endsWith("workspace.yaml") ? "id: real-id\nname: MyName\n" : ""),
    })
    expect(await findSessionDir("real-id", d)).toBe("/home/.copilot/session-state/dir-a")
    expect(await findSessionDir("myname", d)).toBe("/home/.copilot/session-state/dir-a")
  })

  it("returns undefined when nothing matches", async () => {
    const d = deps({ readdir: async (p) => (p.endsWith("session-state") ? ["dir-a"] : []) })
    expect(await findSessionDir("nope", d)).toBeUndefined()
  })
})

describe("readHistoryWithMetrics / readHistory / deleteHistory", () => {
  it("returns empty messages when the session dir isn't found", async () => {
    expect(await readHistoryWithMetrics("nope", deps())).toEqual({ messages: [] })
    expect(await readHistory("nope", deps())).toEqual([])
  })

  it("parses events.jsonl for a matched session and includes usage metrics", async () => {
    const raw = [
      JSON.stringify({ type: "session.start", data: { sessionId: "s1" } }),
      JSON.stringify({ type: "user.message", data: { content: "hi" } }),
      JSON.stringify({
        type: "session.shutdown",
        data: { currentTokens: 10, modelMetrics: { m: { usage: { inputTokens: 5, outputTokens: 5 } } } },
      }),
    ].join("\n")
    const d = deps({
      readdir: async (p) => (p.endsWith("session-state") ? ["dir-a"] : []),
      readFile: async (p) => (p.endsWith("events.jsonl") ? raw : "id: dir-a\n"),
    })
    const result = await readHistoryWithMetrics("dir-a", d)
    expect(result.messages).toHaveLength(1)
    expect(result.usageMetrics).toEqual({ input_tokens: 5, output_tokens: 5, context_tokens: 10 })
  })

  it("deleteHistory removes the matched session dir via deps.rm", async () => {
    const removed: string[] = []
    const d = deps({
      readdir: async (p) => (p.endsWith("session-state") ? ["dir-a"] : []),
      rm: async (p) => {
        removed.push(p)
      },
    })
    await deleteHistory("dir-a", d)
    expect(removed).toEqual(["/home/.copilot/session-state/dir-a"])
  })

  it("deleteHistory is a no-op when no session dir matches", async () => {
    const removed: string[] = []
    const d = deps({
      rm: async (p) => {
        removed.push(p)
      },
    })
    await deleteHistory("nope", d)
    expect(removed).toEqual([])
  })
})

describe("parseEvents — remaining record types", () => {
  it("tracks a tool call name from execution_start and surfaces it on execution_complete", () => {
    const raw = [
      JSON.stringify({ type: "tool.execution_start", data: { toolCallId: "t1", toolName: "Bash" } }),
      JSON.stringify({ type: "tool.execution_complete", data: { toolCallId: "t1", result: { out: "ok" } } }),
    ].join("\n")
    const { messages } = parseEvents(raw, "fallback")
    expect(messages).toEqual([
      {
        role: "assistant",
        blocks: [{ type: "tool_result", callId: "t1", output: { out: "ok" }, isError: false }],
        timestamp: expect.any(String),
        sessionId: "fallback",
      },
    ])
  })

  it("marks isError and a success:false output when the tool call failed", () => {
    const raw = JSON.stringify({ type: "tool.execution_complete", data: { toolCallId: "t1", success: false } })
    const { messages } = parseEvents(raw, "fallback")
    expect(messages[0]?.blocks[0]).toEqual({
      type: "tool_result",
      callId: "t1",
      output: { success: false },
      isError: true,
    })
  })

  it("drops a tool.execution_complete with no toolCallId", () => {
    const raw = JSON.stringify({ type: "tool.execution_complete", data: {} })
    expect(parseEvents(raw, "fallback").messages).toEqual([])
  })

  it("normalizes assistant.message toolRequests using id/name or toolCallId/toolName fallbacks", () => {
    const raw = JSON.stringify({
      type: "assistant.message",
      data: {
        content: "doing it",
        toolRequests: [
          { id: "r1", name: "Edit", arguments: { file: "a.ts" } },
          { toolCallId: "r2", toolName: "Bash" },
        ],
      },
    })
    const { messages } = parseEvents(raw, "fallback")
    expect(messages[0]?.blocks).toEqual([
      { type: "text", text: "doing it" },
      { type: "tool_call", callId: "r1", name: "Edit", input: { file: "a.ts" } },
      { type: "tool_call", callId: "r2", name: "Bash", input: {} },
    ])
  })

  it("drops an assistant.message with no text and no toolRequests", () => {
    const raw = JSON.stringify({ type: "assistant.message", data: {} })
    expect(parseEvents(raw, "fallback").messages).toEqual([])
  })

  it("captures usage on session.shutdown, undefined when there's nothing to report", () => {
    const withUsage = JSON.stringify({ type: "session.shutdown", data: { currentTokens: 5, modelMetrics: {} } })
    expect(parseEvents(withUsage, "fallback").usageMetrics).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      context_tokens: 5,
    })
    const empty = JSON.stringify({ type: "session.shutdown", data: {} })
    expect(parseEvents(empty, "fallback").usageMetrics).toBeUndefined()
  })

  it("skips blank lines, non-JSON lines, and records with no string type", () => {
    const raw = ["", "   ", "{not json", JSON.stringify({ data: {} }), JSON.stringify({ type: 42 })].join("\n")
    expect(parseEvents(raw, "fallback")).toEqual({ messages: [], usageMetrics: undefined, firstUserMessage: null })
  })

  it("skips a user.message with empty content and doesn't set firstUserMessage", () => {
    const raw = JSON.stringify({ type: "user.message", data: { content: "" } })
    const result = parseEvents(raw, "fallback")
    expect(result.messages).toEqual([])
    expect(result.firstUserMessage).toBeNull()
  })

  it("adopts the sessionId recorded on session.start for subsequent messages", () => {
    const raw = [
      JSON.stringify({ type: "session.start", data: { sessionId: "real-id" } }),
      JSON.stringify({ type: "user.message", data: { content: "hi" } }),
    ].join("\n")
    const { messages } = parseEvents(raw, "fallback")
    expect(messages[0]?.sessionId).toBe("real-id")
  })
})
