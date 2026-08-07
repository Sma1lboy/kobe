// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applyLiveTraceEvent,
  type EngineTrace,
  subscribeLiveTrace,
  subscribeTrace,
} from "../src/lib/trace.ts"

class EventSourceStub extends EventTarget {
  static instances: EventSourceStub[] = []
  readonly url: string
  closed = false

  constructor(url: string) {
    super()
    this.url = url
    EventSourceStub.instances.push(this)
  }

  close(): void {
    this.closed = true
  }
}

describe("subscribeTrace", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    EventSourceStub.instances = []
  })

  it("consumes reconnect-safe snapshots and closes the subscription", () => {
    vi.stubGlobal("EventSource", EventSourceStub)
    const seen: unknown[] = []
    const errors: string[] = []
    const unsubscribe = subscribeTrace(
      "codex",
      "session-1",
      (trace) => seen.push(trace),
      (error) => errors.push(error),
    )

    const source = EventSourceStub.instances[0]
    expect(source?.url).toBe(
      "/api/history/trace/events?vendor=codex&sessionId=session-1",
    )
    source?.dispatchEvent(
      new MessageEvent("trace", {
        data: JSON.stringify({ sessionId: "session-1", turns: [] }),
      }),
    )
    source?.dispatchEvent(
      new MessageEvent("trace", {
        data: JSON.stringify({ sessionId: "another-session", turns: [] }),
      }),
    )
    source?.dispatchEvent(
      new MessageEvent("trace-error", {
        data: JSON.stringify({ error: "temporary read failure" }),
      }),
    )

    expect(seen).toEqual([{ sessionId: "session-1", turns: [] }])
    expect(errors).toEqual(["temporary read failure"])
    unsubscribe()
    expect(source?.closed).toBe(true)
  })

  it("scopes the low-latency hook rail by task and session", () => {
    vi.stubGlobal("EventSource", EventSourceStub)
    const seen: unknown[] = []
    const unsubscribe = subscribeLiveTrace("task-1", "session-1", (event) =>
      seen.push(event),
    )
    const source = EventSourceStub.instances[0]
    expect(source?.url).toBe(
      "/api/history/trace/live?taskId=task-1&sessionId=session-1",
    )
    source?.dispatchEvent(
      new MessageEvent("trace-event", {
        data: JSON.stringify({
          kind: "tool-pre",
          sessionId: "session-1",
          at: 10,
        }),
      }),
    )
    source?.dispatchEvent(
      new MessageEvent("trace-event", {
        data: JSON.stringify({
          kind: "tool-pre",
          sessionId: "other",
          at: 11,
        }),
      }),
    )
    expect(seen).toHaveLength(1)
    unsubscribe()
    expect(source?.closed).toBe(true)
  })
})

describe("applyLiveTraceEvent", () => {
  const empty = (): EngineTrace => ({ sessionId: "session-1", turns: [] })

  it("reconciles tool pre/post by stable hook ID without inventing causality", () => {
    const started = applyLiveTraceEvent(empty(), {
      kind: "turn-start",
      sessionId: "session-1",
      at: 10,
      detail: { turnId: "turn-1" },
    })
    const pre = applyLiveTraceEvent(started, {
      kind: "tool-pre",
      sessionId: "session-1",
      at: 11,
      detail: {
        turnId: "turn-1",
        tool: {
          id: "call-1",
          name: "exec_command",
          input: '{"cmd":"pwd"}',
        },
      },
    })
    const post = applyLiveTraceEvent(pre, {
      kind: "tool-post",
      sessionId: "session-1",
      at: 12,
      detail: {
        turnId: "turn-1",
        tool: {
          id: "call-1",
          name: "exec_command",
          output: "/repo",
          isError: false,
        },
      },
    })

    expect(post.turns).toHaveLength(1)
    expect(post.turns[0]?.nodes).toHaveLength(1)
    expect(post.turns[0]?.nodes[0]).toMatchObject({
      id: "call-1",
      parentId: null,
      parentBasis: "none",
      status: "success",
      detail: '{"cmd":"pwd"}',
      resultDetail: "/repo",
    })
  })

  it("does not let a replayed pre-hook downgrade a settled persisted node", () => {
    const persisted: EngineTrace = {
      sessionId: "session-1",
      turns: [
        {
          id: "turn-1",
          title: "Inspect",
          startedAt: 1,
          endedAt: 20,
          status: "success",
          nodes: [
            {
              id: "call-1",
              turnId: "turn-1",
              parentId: "commentary-1",
              parentBasis: "temporal",
              kind: "tool",
              status: "success",
              title: "exec_command",
              summary: "pwd",
              detail: "pwd",
              resultDetail: "/repo",
              startedAt: 5,
              endedAt: 10,
            },
          ],
        },
      ],
    }
    const next = applyLiveTraceEvent(persisted, {
      kind: "tool-pre",
      sessionId: "session-1",
      at: 5,
      detail: {
        turnId: "turn-1",
        tool: { id: "call-1", name: "exec_command" },
      },
    })
    expect(next).toEqual(persisted)
  })

  it("reconciles a subagent lifecycle and preserves engine-native completion facts", () => {
    const started = applyLiveTraceEvent(empty(), {
      kind: "subagent-start",
      sessionId: "session-1",
      at: 10,
      detail: {
        turnId: "turn-1",
        subagent: { id: "agent-7", type: "reviewer" },
      },
    })
    const stopped = applyLiveTraceEvent(started, {
      kind: "subagent-stop",
      sessionId: "session-1",
      at: 20,
      detail: {
        turnId: "turn-1",
        subagent: {
          id: "agent-7",
          type: "reviewer",
          transcriptPath: "/tmp/subagent.jsonl",
          result: "Focused tests pass.",
        },
      },
    })

    expect(stopped.turns[0]?.nodes).toEqual([
      expect.objectContaining({
        id: "agent-7",
        kind: "subagent",
        status: "success",
        detail: "agent-7\n/tmp/subagent.jsonl",
        resultDetail: "Focused tests pass.",
        startedAt: 10,
        endedAt: 20,
      }),
    ])
  })
})
