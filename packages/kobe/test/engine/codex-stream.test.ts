import { parseStreamJson } from "@/engine/codex-local/stream"
import { describe, expect, it } from "vitest"

async function collect(lines: readonly string[], onSessionId: (sessionId: string) => void = () => {}) {
  const events = []
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
})
