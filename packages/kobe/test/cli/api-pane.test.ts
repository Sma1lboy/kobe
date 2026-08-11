/** Request-traffic tests for the `pane-open` verb. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invokeVerb } from "../../src/cli/api-cmd.ts"
import { FakeClient, expectApiError, stubRuntime } from "./api-handler-fixtures.ts"

describe("pane-open handler", () => {
  beforeEach(() => {
    vi.stubEnv("KOBE_TASK_ID", "env-task")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("wraps --command in sh -lc, defaults split/right, titles from the command word", async () => {
    const client = new FakeClient({ "tab.open": () => ({ ok: true }) })
    await invokeVerb("pane-open", ["--command", "btop --utf-force"], { client, runtime: stubRuntime() })
    expect(client.requestNames).toEqual(["tab.open"])
    expect(client.requests[0].payload).toEqual({
      taskId: "env-task",
      argv: ["sh", "-lc", "btop --utf-force"],
      title: "btop",
      placement: "split",
      direction: "right",
    })
  })

  it("no --command opens an interactive shell; explicit flags pass through", async () => {
    const client = new FakeClient({ "tab.open": () => ({ ok: true }) })
    await invokeVerb("pane-open", ["--task-id", "t9", "--direction", "down", "--placement", "tab", "--title", "logs"], {
      client,
      runtime: stubRuntime(),
    })
    const payload = client.requests[0].payload as { taskId: string; argv: string[]; title: string }
    expect(payload.taskId).toBe("t9")
    expect(payload.argv).toHaveLength(1) // the shell itself, no -lc wrap
    expect(payload.title).toBe("logs")
    expect(client.requests[0].payload).toMatchObject({ placement: "tab", direction: "down" })
  })

  it("rejects an out-of-range --direction before any RPC", async () => {
    const client = new FakeClient()
    await expectApiError(
      () => invokeVerb("pane-open", ["--direction", "sideways"], { client, runtime: stubRuntime() }),
      "BAD_FLAG",
    )
    expect(client.requestNames).toEqual([])
  })
})
