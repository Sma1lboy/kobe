import { describe, expect, test } from "vitest"
import { describeDelegationProtocol } from "../../src/core/task-delegation-protocol.ts"
import { buildDelegationBootstrapPrompt } from "../../src/tui/workspace/task-delegation.ts"
import { type Task, toTaskId } from "../../src/types/task.ts"

function task(id: string, title: string): Task {
  return {
    id: toTaskId(id),
    title,
    repo: `/repo/${id}`,
    branch: `kobe/${id}`,
    worktreePath: `/wt/${id}`,
    status: "in_progress",
    archived: false,
    vendor: "codex",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }
}

describe("subagent delegation bootstrap", () => {
  test("addresses both roles explicitly and forbids channel/fork semantics", () => {
    const prompt = buildDelegationBootstrapPrompt(task("PRIMARY01", "Coordinator"), task("WORKER01", "Research"))
    expect(prompt).toContain("[KOBE DELEGATION LINK v2]")
    expect(prompt).toContain("You are the PRIMARY agent")
    expect(prompt).toContain("primary_task_id: PRIMARY01")
    expect(prompt).toContain("subagent_task_id: WORKER01")
    expect(prompt).toContain("kobe api send --task-id WORKER01")
    expect(prompt).toContain("kobe api delegation-protocol --primary-task-id PRIMARY01 --subagent-task-id WORKER01")
    expect(prompt).toContain("no shared channel was created")
    expect(prompt).toContain("Do not recursively delegate")
    expect(prompt).not.toContain("objective: <one bounded outcome>")
  })

  test("the canonical v2 contract correlates one request/result pair and terminates the default chain", () => {
    const protocol = describeDelegationProtocol({
      primaryTaskId: "PRIMARY01",
      subagentTaskId: "WORKER01",
      requestId: "req_TEST",
    })
    expect(protocol).toMatchObject({
      name: "kobe.task-delegation",
      version: 2,
      sourceOfTruth: "kobe api delegation-protocol",
      defaults: { maxHops: 2 },
    })
    expect(protocol.requestTemplate).toContain("request_id: req_TEST")
    expect(protocol.requestTemplate).toContain("hop: 1")
    expect(protocol.requestTemplate).toContain("reply_policy: required_once")
    expect(protocol.requestTemplate).toContain("target_task_id: WORKER01")
    expect(protocol.requestTemplate).toContain("--request-id 'req_TEST'")
    expect(protocol.resultTemplate).toContain("hop: 2")
    expect(protocol.resultTemplate).toContain("reply_policy: none")
    expect(protocol.resultTemplate).toContain("target_task_id: PRIMARY01")
    expect(protocol.semantics.templates).toContain("actual next value")
    expect(() => describeDelegationProtocol({ maxHops: 1 })).toThrow(/at least 2/)
  })
})
