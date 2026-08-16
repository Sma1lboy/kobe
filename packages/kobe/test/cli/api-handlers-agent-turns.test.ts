/** `agent-turns` — the totals roll-up and the filter it sends the daemon. */

import type { AgentTurnRecord } from "@sma1lboy/kobe-daemon/daemon/contracts"
import { describe, expect, it } from "vitest"
import { invokeVerb } from "../../src/cli/api-cmd.ts"
import { summarizeTurns } from "../../src/cli/api/handlers-agent-turns.ts"
import { FakeClient, stubRuntime } from "./api-handler-fixtures.ts"

const runtime = stubRuntime()

function turn(over: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    id: "msg_a",
    taskId: "t1",
    vendor: "claude",
    model: "claude-opus-5",
    startedAt: 1_000,
    endedAt: 4_000,
    usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    ...over,
  }
}

describe("summarizeTurns", () => {
  it("sums tokens and wall-clock, and counts turns per model", () => {
    expect(summarizeTurns([turn(), turn({ id: "msg_b", model: "claude-sonnet-5", endedAt: 2_000 })])).toEqual({
      turns: 2,
      inputTokens: 20,
      outputTokens: 200,
      cacheReadTokens: 10,
      cacheCreationTokens: 4,
      durationMs: 4_000,
      byModel: { "claude-opus-5": 1, "claude-sonnet-5": 1 },
    })
  })

  it("tolerates missing usage/model and never reports a negative duration", () => {
    const t = summarizeTurns([turn({ usage: undefined, model: undefined, startedAt: 9_000, endedAt: 1_000 })])
    expect(t).toMatchObject({ turns: 1, inputTokens: 0, durationMs: 0, byModel: { unknown: 1 } })
  })

  it("an empty page summarizes to zeros", () => {
    expect(summarizeTurns([])).toMatchObject({ turns: 0, outputTokens: 0, byModel: {} })
  })
})

describe("agent-turns handler", () => {
  it("passes task/limit through and returns totals alongside the page", async () => {
    const seen: Record<string, unknown>[] = []
    const client = new FakeClient({
      "agentTurn.list": (payload) => {
        seen.push(payload as Record<string, unknown>)
        return { turns: [turn()] }
      },
    })
    const result = (await invokeVerb("agent-turns", ["--task-id", "t1", "--limit", "5"], { client, runtime })) as {
      totals: { turns: number }
      turns: AgentTurnRecord[]
    }
    expect(seen[0]).toMatchObject({ taskId: "t1", limit: 5 })
    expect(typeof seen[0].since).toBe("number")
    expect(seen[0].repoRoot).toBeUndefined()
    expect(result.totals.turns).toBe(1)
    expect(result.turns).toHaveLength(1)
  })

  it("resolves --repo to a repo root before filtering", async () => {
    const seen: Record<string, unknown>[] = []
    const client = new FakeClient({
      "agentTurn.list": (payload) => {
        seen.push(payload as Record<string, unknown>)
        return { turns: [] }
      },
    })
    await invokeVerb("agent-turns", ["--repo", "/repo/x"], {
      client,
      runtime: stubRuntime({ resolveRepoRoot: async () => "/repo/root" }),
    })
    expect(seen[0].repoRoot).toBe("/repo/root")
  })
})
