import { describe, expect, test } from "vitest"
import { codexCapabilities, codexIdentity } from "../../src/engine/codex-local/capabilities.ts"
import { MetadataSuggester } from "../../src/orchestrator/metadata-suggester.ts"
import type {
  AIEngine,
  EngineEvent,
  EngineHistory,
  Message,
  SessionHandle,
  SessionMeta,
  SpawnOpts,
} from "../../src/types/engine.ts"

class OneShotEngine implements AIEngine {
  readonly identity = codexIdentity
  readonly capabilities = codexCapabilities
  readonly spawns: Array<{ cwd: string; prompt: string; opts?: SpawnOpts }> = []
  readonly deleted: string[] = []
  readonly stopped: string[] = []

  constructor(private readonly events: readonly EngineEvent[]) {}

  async spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    this.spawns.push({ cwd, prompt, ...(opts ? { opts } : {}) })
    return { sessionId: "metadata-session", cwd }
  }

  async resume(sessionId: string, _prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    return { sessionId, cwd: opts?.cwd ?? "/" }
  }

  stream(_handle: SessionHandle): AsyncIterable<EngineEvent> {
    const events = this.events
    return (async function* () {
      for (const ev of events) yield ev
    })()
  }

  async readHistory(_sessionId: string): Promise<EngineHistory> {
    return { messages: [] }
  }

  async listSessions(_cwd: string): Promise<SessionMeta[]> {
    return []
  }

  async deleteHistory(sessionId: string): Promise<void> {
    this.deleted.push(sessionId)
  }

  async stop(handle: SessionHandle): Promise<void> {
    this.stopped.push(handle.sessionId)
  }
}

describe("MetadataSuggester", () => {
  test("routes suggestions through the supplied AIEngine with selected model options", async () => {
    const engine = new OneShotEngine([{ type: "assistant.delta", text: "Fix Metadata Naming" }, { type: "done" }])
    const suggester = new MetadataSuggester()

    const title = await suggester.suggestTitle("fix metadata naming", {
      engine,
      cwd: "/tmp/worktree",
      model: "gpt-5.5",
      modelEffort: "xhigh",
      permissionMode: "plan",
    })

    expect(title).toBe("Fix Metadata Naming")
    expect(engine.spawns).toHaveLength(1)
    expect(engine.spawns[0]?.cwd).toBe("/tmp/worktree")
    expect(engine.spawns[0]?.prompt).toContain("Generate a short feature-style task name")
    expect(engine.spawns[0]?.prompt).toContain("fix metadata naming")
    expect(engine.spawns[0]?.opts).toMatchObject({
      model: "gpt-5.5",
      modelEffort: "xhigh",
      permissionMode: "plan",
    })
    expect(engine.deleted).toEqual(["metadata-session"])
  })

  test("suggestRecap serializes transcript and returns sanitized 1-3 sentence body", async () => {
    const engine = new OneShotEngine([
      // Mimic a chatty model adding the kind of preamble haiku tends to add.
      { type: "assistant.delta", text: "Recap: Refactoring the auth middleware. Next: hook up rate limiting." },
      { type: "done" },
    ])
    const suggester = new MetadataSuggester()
    const history: Message[] = [
      {
        role: "user",
        blocks: [{ type: "text", text: "let's refactor the auth middleware" }],
        timestamp: "2026-05-18T10:00:00Z",
        sessionId: "s1",
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Moved session checks into MiddlewareGuard." }],
        timestamp: "2026-05-18T10:05:00Z",
        sessionId: "s1",
      },
    ]

    const text = await suggester.suggestRecap(history, {
      engine,
      cwd: "/tmp/worktree",
      model: "claude-haiku-4-5-20251001",
    })

    expect(text).toBe("Refactoring the auth middleware. Next: hook up rate limiting.")
    expect(engine.spawns).toHaveLength(1)
    const prompt = engine.spawns[0]?.prompt ?? ""
    expect(prompt).toContain("user: let's refactor the auth middleware")
    expect(prompt).toContain("assistant: Moved session checks into MiddlewareGuard.")
    expect(prompt).toContain("1-3 short sentences")
    expect(engine.deleted).toEqual(["metadata-session"])
  })

  test("suggestRecap returns null on empty transcript", async () => {
    const engine = new OneShotEngine([])
    const suggester = new MetadataSuggester()
    const text = await suggester.suggestRecap([], { engine, cwd: "/tmp/x" })
    expect(text).toBeNull()
    expect(engine.spawns).toHaveLength(0)
  })

  test("suggestRecap returns null when transcript has only tool-call blocks", async () => {
    const engine = new OneShotEngine([])
    const suggester = new MetadataSuggester()
    const history: Message[] = [
      {
        role: "assistant",
        blocks: [{ type: "tool_call", callId: "c1", name: "Bash", input: { cmd: "ls" } }],
        timestamp: "2026-05-18T10:00:00Z",
        sessionId: "s1",
      },
    ]
    const text = await suggester.suggestRecap(history, { engine, cwd: "/tmp/x" })
    expect(text).toBeNull()
    expect(engine.spawns).toHaveLength(0)
  })
})
