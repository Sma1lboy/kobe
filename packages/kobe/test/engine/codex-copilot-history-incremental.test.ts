import { describe, expect, it } from "vitest"
import type { HistoryDeps } from "../../src/engine/codex-local/history.ts"
import {
  readHistory as readCodexHistory,
  readHistoryWithMetrics as readCodexHistoryWithMetrics,
} from "../../src/engine/codex-local/history.ts"
import type { CopilotHistoryDeps } from "../../src/engine/copilot-local/history.ts"
import {
  readHistory as readCopilotHistory,
  readHistoryWithMetrics as readCopilotHistoryWithMetrics,
} from "../../src/engine/copilot-local/history.ts"

const CODEX_UUID = "aaaaaaaa-1111-2222-3333-444444444444"
const CODEX_ROLLOUT = `rollout-2026-06-10T01-00-00-${CODEX_UUID}.jsonl`

function codexMsg(role: "user" | "assistant", text: string, ts: string): string {
  const type = role === "user" ? "input_text" : "output_text"
  return JSON.stringify({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", role, content: [{ type, text }] },
  })
}

function codexTurn(output: number): string {
  return JSON.stringify({ type: "turn.completed", usage: { output_tokens: output } })
}

function codexDeps(name: string): { deps: HistoryDeps; set: (raw: string) => void } {
  let raw = ""
  const root = `/codex-${name}`
  const deps: HistoryDeps = {
    sessionsDir: () => root,
    readdir: async (p) => {
      if (p === root) return ["2026"]
      if (p === `${root}/2026`) return ["06"]
      if (p === `${root}/2026/06`) return ["10"]
      if (p === `${root}/2026/06/10`) return [CODEX_ROLLOUT]
      return []
    },
    readFile: async (p) => {
      if (p !== `${root}/2026/06/10/${CODEX_ROLLOUT}`) throw new Error("ENOENT")
      return raw
    },
    stat: async () => ({ mtimeMs: 1 }),
  }
  return {
    deps,
    set: (next) => {
      raw = next
    },
  }
}

describe("codex readHistory append-aware cache", () => {
  it("append: already-seen messages keep object identity; new ones are appended", async () => {
    const { deps, set } = codexDeps("append")
    const l1 = codexMsg("user", "first", "2026-06-10T01:00:01Z")
    const l2 = codexMsg("assistant", "second", "2026-06-10T01:00:02Z")
    set(`${l1}\n${l2}\n`)

    const first = await readCodexHistory(CODEX_UUID, deps)
    expect(first.map((m) => m.blocks)).toEqual([[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]])

    const l3 = codexMsg("user", "third", "2026-06-10T01:00:03Z")
    set(`${l1}\n${l2}\n${l3}\n`)
    const second = await readCodexHistory(CODEX_UUID, deps)

    expect(second).toHaveLength(3)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]?.blocks).toEqual([{ type: "text", text: "third" }])
  })

  it("rewrite: a changed prefix falls back to a full re-parse", async () => {
    const { deps, set } = codexDeps("rewrite")
    set(`${codexMsg("user", "original", "2026-06-10T01:00:01Z")}\n`)
    await readCodexHistory(CODEX_UUID, deps)

    set(
      `${codexMsg("user", "rewritten", "2026-06-10T01:00:01Z")}\n${codexMsg("assistant", "after", "2026-06-10T01:00:02Z")}\n`,
    )
    const out = await readCodexHistory(CODEX_UUID, deps)
    expect(out.map((m) => m.blocks[0])).toEqual([
      { type: "text", text: "rewritten" },
      { type: "text", text: "after" },
    ])
  })

  it("truncation: a shorter file falls back to a full re-parse", async () => {
    const { deps, set } = codexDeps("truncate")
    const l1 = codexMsg("user", "keep", "2026-06-10T01:00:01Z")
    set(`${l1}\n${codexMsg("assistant", "dropped", "2026-06-10T01:00:02Z")}\n`)
    expect(await readCodexHistory(CODEX_UUID, deps)).toHaveLength(2)

    set(`${l1}\n`)
    const out = await readCodexHistory(CODEX_UUID, deps)
    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([{ type: "text", text: "keep" }])
  })

  it("usage metrics keep advancing across appends (fold state, not first-turn freeze)", async () => {
    const { deps, set } = codexDeps("usage")
    const l1 = codexMsg("user", "hi", "2026-06-10T01:00:01Z")
    set(`${l1}\n${codexTurn(10)}\n`)
    const first = await readCodexHistoryWithMetrics(CODEX_UUID, deps)
    expect(first.usageMetrics).toEqual({ input_tokens: 0, output_tokens: 10 })

    set(`${l1}\n${codexTurn(10)}\n${codexTurn(30)}\n`)
    const second = await readCodexHistoryWithMetrics(CODEX_UUID, deps)
    expect(second.usageMetrics).toEqual({ input_tokens: 0, output_tokens: 30 })
    expect(second.messages[0]).toBe(first.messages[0])
  })
})

function copilotEvent(type: string, data: Record<string, unknown>, ts: string): string {
  return JSON.stringify({ type, data, timestamp: ts })
}

function copilotDeps(name: string): { deps: CopilotHistoryDeps; set: (raw: string) => void } {
  let events = ""
  const root = `/copilot-${name}`
  const dir = `${root}/session-state/sess1`
  const deps: CopilotHistoryDeps = {
    copilotDir: () => root,
    readdir: async (p) => (p === `${root}/session-state` ? ["sess1"] : []),
    readFile: async (p) => {
      if (p === `${dir}/workspace.yaml`) return 'id: sess1\ncwd: "/wt"\n'
      if (p === `${dir}/events.jsonl`) return events
      throw new Error("ENOENT")
    },
    stat: async () => ({ mtimeMs: 1 }),
    rm: async () => {},
  }
  return {
    deps,
    set: (next) => {
      events = next
    },
  }
}

describe("copilot readHistory append-aware cache", () => {
  it("append: already-seen messages keep object identity; new ones are appended", async () => {
    const { deps, set } = copilotDeps("append")
    const l1 = copilotEvent("user.message", { content: "first" }, "2026-06-10T01:00:01Z")
    const l2 = copilotEvent("assistant.message", { content: "second" }, "2026-06-10T01:00:02Z")
    set(`${l1}\n${l2}\n`)

    const first = await readCopilotHistory("sess1", deps)
    expect(first.map((m) => m.blocks)).toEqual([[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]])

    const l3 = copilotEvent("user.message", { content: "third" }, "2026-06-10T01:00:03Z")
    set(`${l1}\n${l2}\n${l3}\n`)
    const second = await readCopilotHistory("sess1", deps)

    expect(second).toHaveLength(3)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]?.blocks).toEqual([{ type: "text", text: "third" }])
  })

  it("rewrite: a changed prefix falls back to a full re-parse", async () => {
    const { deps, set } = copilotDeps("rewrite")
    set(`${copilotEvent("user.message", { content: "original" }, "2026-06-10T01:00:01Z")}\n`)
    await readCopilotHistory("sess1", deps)

    set(`${copilotEvent("user.message", { content: "rewritten" }, "2026-06-10T01:00:01Z")}\n`)
    const out = await readCopilotHistory("sess1", deps)
    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([{ type: "text", text: "rewritten" }])
  })

  it("cross-line fold state survives the cache boundary (session.start id applies to appended lines)", async () => {
    const { deps, set } = copilotDeps("state")
    const start = copilotEvent("session.start", { sessionId: "real-sid" }, "2026-06-10T01:00:00Z")
    const l1 = copilotEvent("user.message", { content: "hi" }, "2026-06-10T01:00:01Z")
    set(`${start}\n${l1}\n`)
    const first = await readCopilotHistory("sess1", deps)
    expect(first[0]?.sessionId).toBe("real-sid")

    const l2 = copilotEvent("assistant.message", { content: "yo" }, "2026-06-10T01:00:02Z")
    set(`${start}\n${l1}\n${l2}\n`)
    const second = await readCopilotHistory("sess1", deps)
    expect(second).toHaveLength(2)
    expect(second[0]).toBe(first[0])
    expect(second[1]?.sessionId).toBe("real-sid")
  })

  it("usage metrics from an appended session.shutdown are picked up", async () => {
    const { deps, set } = copilotDeps("usage")
    const l1 = copilotEvent("user.message", { content: "hi" }, "2026-06-10T01:00:01Z")
    set(`${l1}\n`)
    const first = await readCopilotHistoryWithMetrics("sess1", deps)
    expect(first.usageMetrics).toBeUndefined()

    const shutdown = copilotEvent(
      "session.shutdown",
      { modelMetrics: { m: { usage: { inputTokens: 5, outputTokens: 7 } } } },
      "2026-06-10T01:00:02Z",
    )
    set(`${l1}\n${shutdown}\n`)
    const second = await readCopilotHistoryWithMetrics("sess1", deps)
    expect(second.usageMetrics).toEqual({ input_tokens: 5, output_tokens: 7 })
    expect(second.messages[0]).toBe(first.messages[0])
  })
})
