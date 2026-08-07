import { afterEach, describe, expect, it } from "vitest"
import { type DaemonHarness, bootDaemonHarness } from "./harness.ts"

describe("daemon web live trace SSE", () => {
  let harness: DaemonHarness | undefined

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  it("replays and filters the task/session-scoped engine event ring", async () => {
    harness = await bootDaemonHarness({ web: true })
    const web = harness.web
    expect(web).not.toBeNull()
    web?.engineEvents.append("task-1", {
      kind: "tool-pre",
      sessionId: "other-session",
      at: 9,
    })
    web?.engineEvents.append("task-1", {
      kind: "tool-pre",
      sessionId: "session-1",
      detail: { turnId: "turn-1", tool: { id: "call-1" } },
      at: 10,
    })

    const response = await web?.fetch("/api/history/trace/live?taskId=task-1&sessionId=session-1")
    expect(response?.status).toBe(200)
    expect(response?.headers.get("content-type")).toBe("text/event-stream")
    const reader = response?.body?.getReader()
    const first = await reader?.read()
    await reader?.cancel()
    const text = new TextDecoder().decode(first?.value)
    expect(text).toContain("event: trace-event")
    expect(text).toContain('"sessionId":"session-1"')
    expect(text).toContain('"id":"call-1"')
    expect(text).not.toContain("other-session")
  })

  it("rejects unscoped and path-shaped subscriptions", async () => {
    harness = await bootDaemonHarness({ web: true })
    expect((await harness.web?.fetch("/api/history/trace/live?taskId=../task&sessionId=session-1"))?.status).toBe(400)
    expect((await harness.web?.fetch("/api/history/trace/live?taskId=task-1"))?.status).toBe(400)
  })
})
