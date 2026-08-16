/** Durable per-turn telemetry: store persistence + the hook-driven ingest (issue #32). */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ingestAgentTurns } from "@sma1lboy/kobe-daemon/daemon/agent-turns-ingest"
import { AgentTurnsStore } from "@sma1lboy/kobe-daemon/daemon/agent-turns-store"
import type { AgentTurn, AgentTurnRecord, DaemonOrchestrator } from "@sma1lboy/kobe-daemon/daemon/contracts"
import type { DaemonRuntimeAdapter } from "@sma1lboy/kobe-daemon/daemon/runtime"
import { afterEach, describe, expect, it } from "vitest"

let dir: string | null = null

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

async function createStore(): Promise<{ store: AgentTurnsStore; path: string }> {
  dir = await mkdtemp(join(tmpdir(), "kobe-agent-turns-"))
  const path = join(dir, "agent-turns.json")
  const store = new AgentTurnsStore(path)
  await store.init()
  return { store, path }
}

function record(over: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    id: "msg_a",
    taskId: "task-1",
    vendor: "claude",
    model: "claude-opus-5",
    repo: "/repo",
    startedAt: 1000,
    endedAt: 2000,
    usage: { input_tokens: 1, output_tokens: 2 },
    ...over,
  }
}

describe("AgentTurnsStore", () => {
  it("persists turns and reloads them", async () => {
    const { store, path } = await createStore()
    expect(await store.record([record()])).toBe(1)

    const reloaded = new AgentTurnsStore(path)
    await reloaded.init()
    expect(reloaded.list()).toEqual([record()])
  })

  it("dedupes a re-read of the same turn (the every-Stop re-scan)", async () => {
    const { store } = await createStore()
    expect(await store.record([record()])).toBe(1)
    expect(await store.record([record(), record({ id: "msg_b", endedAt: 3000 })])).toBe(1)
    expect(store.list().map((t) => t.id)).toEqual(["msg_b", "msg_a"]) // newest first
  })

  it("scopes the dedupe key by task, so two tasks may carry the same engine id", async () => {
    const { store } = await createStore()
    await store.record([record(), record({ taskId: "task-2" })])
    expect(store.list()).toHaveLength(2)
  })

  it("filters by task, repo, and since; drops malformed rows", async () => {
    const { store } = await createStore()
    await store.record([
      record(),
      record({ id: "msg_b", taskId: "task-2", repo: "/other", endedAt: 9000 }),
      { id: "", taskId: "task-3", startedAt: 1, endedAt: 2 } as AgentTurnRecord,
    ])
    expect(store.list({ taskId: "task-2" }).map((t) => t.id)).toEqual(["msg_b"])
    expect(store.list({ repo: "/repo" }).map((t) => t.id)).toEqual(["msg_a"])
    expect(store.list({ since: 5000 }).map((t) => t.id)).toEqual(["msg_b"])
    expect(store.list({ limit: 1 })).toHaveLength(1)
    expect(store.list().some((t) => t.taskId === "task-3")).toBe(false)
  })

  it("drops a deleted task's turns", async () => {
    const { store } = await createStore()
    await store.record([record(), record({ taskId: "task-2" })])
    await store.deleteTask("task-1")
    expect(store.list().map((t) => t.taskId)).toEqual(["task-2"])
  })
})

describe("ingestAgentTurns", () => {
  const engineTurn: AgentTurn = {
    id: "msg_a",
    sessionId: "sess-1",
    model: "claude-opus-5",
    startedAt: 1000,
    endedAt: 2000,
    usage: { input_tokens: 1, output_tokens: 2 },
  }

  function deps(turns: readonly AgentTurn[] = [engineTurn], task: unknown = { repo: "/repo", vendor: "claude" }) {
    const asked: { vendor: string; path: string }[] = []
    const runtime = {
      readEngineTurns: async (vendor: string, path: string) => {
        asked.push({ vendor, path })
        return turns
      },
    } as unknown as DaemonRuntimeAdapter
    const orch = { getTask: () => task } as unknown as DaemonOrchestrator
    return { runtime, orch, asked }
  }

  it("joins engine turns to task identity and records them", async () => {
    const { store } = await createStore()
    const { runtime, orch, asked } = deps()

    expect(
      await ingestAgentTurns(store, runtime, orch, {
        taskId: "task-1",
        tabId: "tab-2",
        vendor: "claude",
        transcriptPath: "/t.jsonl",
      }),
    ).toBe(1)
    expect(asked).toEqual([{ vendor: "claude", path: "/t.jsonl" }])
    expect(store.list()).toEqual([{ ...engineTurn, taskId: "task-1", tabId: "tab-2", vendor: "claude", repo: "/repo" }])
  })

  it("no transcript path and no resolvable vendor are both no-ops", async () => {
    const { store } = await createStore()
    const { runtime, orch, asked } = deps()
    expect(await ingestAgentTurns(store, runtime, orch, { taskId: "task-1" })).toBe(0)

    const vendorless = deps(undefined, { repo: "/repo" })
    expect(
      await ingestAgentTurns(store, vendorless.runtime, vendorless.orch, {
        taskId: "task-1",
        transcriptPath: "/t.jsonl",
      }),
    ).toBe(0)
    expect(asked).toEqual([])
    expect(store.list()).toEqual([])
  })

  it("falls back to the task's vendor when the hook carried no --engine tag", async () => {
    const { store } = await createStore()
    const { runtime, orch, asked } = deps()
    await ingestAgentTurns(store, runtime, orch, { taskId: "task-1", transcriptPath: "/t.jsonl" })
    expect(asked[0].vendor).toBe("claude")
  })
})
