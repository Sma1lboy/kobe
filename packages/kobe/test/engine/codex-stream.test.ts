import { parseStreamJson } from "@/engine/codex-local/stream"
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

describe("codex stream parser", () => {
  it("captures the persisted rollout session id from session_meta", async () => {
    const ids: string[] = []

    await collect(
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "019e1bab-8ee0-7293-b3bc-35636abeae4b" },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
      ],
      (id) => ids.push(id),
    )

    expect(ids).toEqual(["019e1bab-8ee0-7293-b3bc-35636abeae4b"])
  })

  it("falls back to thread.started for older codex json streams", async () => {
    const ids: string[] = []

    await collect(
      [
        JSON.stringify({ type: "thread.started", thread_id: "legacy-thread-id" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
      ],
      (id) => ids.push(id),
    )

    expect(ids).toEqual(["legacy-thread-id"])
  })

  it("does not replace the real session_meta id with a later thread id", async () => {
    const ids: string[] = []

    await collect(
      [
        JSON.stringify({ type: "session_meta", payload: { id: "rollout-id" } }),
        JSON.stringify({ type: "thread.started", thread_id: "thread-id" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
      ],
      (id) => ids.push(id),
    )

    expect(ids).toEqual(["rollout-id"])
  })

  it("normalizes codex cumulative usage without double-counting cached input or reasoning output", async () => {
    const events = await collect([
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          output_tokens: 11,
          reasoning_output_tokens: 500,
        },
      }),
    ])

    expect(events[0]).toEqual({
      type: "usage",
      input_tokens: 70,
      cache_read_input_tokens: 30,
      output_tokens: 11,
    })
  })

  it("threads fallback context-window metadata into usage events", async () => {
    const events: EngineEvent[] = []
    for await (const ev of parseStreamJson(
      lineSource([
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 11 },
        }),
      ]),
      { contextWindowTokens: async () => 1_050_000 },
    )) {
      events.push(ev)
    }

    expect(events[0]).toMatchObject({
      type: "usage",
      context_window_tokens: 1_050_000,
    })
  })

  it("maps reasoning items to a private reasoning row without raw payload", async () => {
    const events = await collect([
      JSON.stringify({
        type: "item.started",
        item: { id: "reason-1", type: "reasoning", summary: [], content: [] },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "reason-1", type: "reasoning", summary: [], content: [] },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
    ])

    expect(events.slice(0, 2)).toEqual([
      { type: "tool.start", name: "reasoning", input: undefined },
      { type: "tool.result", name: "reasoning", output: undefined },
    ])
  })
})
