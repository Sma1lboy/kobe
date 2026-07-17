import { describe, expect, it } from "vitest"
import {
  type CopilotHistoryDeps,
  listSessionIdsForWorktree,
  parseEvents,
  parseWorkspaceYaml,
} from "../../src/engine/copilot-local/history.ts"
import { copilotUsageToSnapshot } from "../../src/engine/copilot-local/usage.ts"

describe("parseWorkspaceYaml", () => {
  it("reads id / cwd / updated_at, stripping quotes", () => {
    const meta = parseWorkspaceYaml('id: abc123\ncwd: "/work/tree"\nupdated_at: 2026-05-01T00:00:00Z\n')
    expect(meta.id).toBe("abc123")
    expect(meta.cwd).toBe("/work/tree")
    expect(meta.updatedAt).toBe("2026-05-01T00:00:00Z")
  })

  it("strips a trailing CR so a CRLF workspace.yaml still matches the worktree", () => {
    // The Copilot CLI writes CRLF line endings on Windows. Without stripping
    // the CR, `cwd` keeps a trailing "\r" (breaking the worktree comparison)
    // and a quoted value fails the endsWith('"') quote-strip.
    const meta = parseWorkspaceYaml('id: abc123\r\ncwd: "/work/tree"\r\nupdated_at: 2026-05-01T00:00:00Z\r\n')
    expect(meta.id).toBe("abc123")
    expect(meta.cwd).toBe("/work/tree")
    expect(meta.updatedAt).toBe("2026-05-01T00:00:00Z")
  })
})

describe("listSessionIdsForWorktree — CRLF workspace.yaml", () => {
  it("matches a worktree whose workspace.yaml uses CRLF line endings", async () => {
    const dirs: Record<string, string> = {
      "crlf/workspace.yaml": "id: crlf\r\ncwd: /wt\r\nupdated_at: 2026-01-01T00:00:00Z\r\n",
    }
    const deps: CopilotHistoryDeps = {
      copilotDir: () => "/home/.copilot",
      readdir: async (p) => (p.endsWith("session-state") ? ["crlf"] : []),
      readFile: async (p) => {
        const key = Object.keys(dirs).find((k) => p.endsWith(k))
        if (!key) throw new Error("missing")
        return dirs[key]
      },
      stat: async () => ({ mtimeMs: 0 }),
      rm: async () => {},
    }
    expect(await listSessionIdsForWorktree("/wt", deps)).toEqual(["crlf"])
  })
})

describe("listSessionIdsForWorktree", () => {
  it("returns only sessions whose workspace cwd matches, oldest-first", async () => {
    const dirs: Record<string, string> = {
      "older/workspace.yaml": "id: older\ncwd: /wt\nupdated_at: 2026-01-01T00:00:00Z\n",
      "newer/workspace.yaml": "id: newer\ncwd: /wt\nupdated_at: 2026-02-01T00:00:00Z\n",
      "other/workspace.yaml": "id: other\ncwd: /elsewhere\nupdated_at: 2026-03-01T00:00:00Z\n",
    }
    const deps: CopilotHistoryDeps = {
      copilotDir: () => "/home/.copilot",
      readdir: async (p) => (p.endsWith("session-state") ? ["older", "newer", "other"] : []),
      readFile: async (p) => {
        const key = Object.keys(dirs).find((k) => p.endsWith(k))
        if (!key) throw new Error("missing")
        return dirs[key]
      },
      stat: async () => ({ mtimeMs: 0 }),
      rm: async () => {},
    }
    expect(await listSessionIdsForWorktree("/wt", deps)).toEqual(["older", "newer"])
  })
})

describe("parseEvents", () => {
  it("turns the copilot event jsonl into neutral messages", () => {
    const raw = [
      JSON.stringify({ type: "session.start", data: { sessionId: "s1" } }),
      JSON.stringify({ type: "user.message", data: { content: "hello" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "hi there" } }),
    ].join("\n")
    const { messages, firstUserMessage } = parseEvents(raw, "fallback")
    expect(firstUserMessage).toBe("hello")
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(messages[0]?.sessionId).toBe("s1")
  })
})

describe("copilotUsageToSnapshot", () => {
  it("sums per-model usage + carries the context figure", () => {
    const snap = copilotUsageToSnapshot({
      currentTokens: 1200,
      modelMetrics: {
        "gpt-5": { usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 10 } },
        "claude-opus": { usage: { inputTokens: 50, outputTokens: 20 } },
      },
    })
    expect(snap).toEqual({
      input_tokens: 150,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      context_tokens: 1200,
    })
  })

  it("returns undefined when there's nothing to report", () => {
    expect(copilotUsageToSnapshot({ modelMetrics: {} })).toBeUndefined()
    expect(copilotUsageToSnapshot(null)).toBeUndefined()
  })
})
