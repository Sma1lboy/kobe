/** Request-traffic tests for the `pane-open` verb. */

import { resolveLoginShell } from "@sma1lboy/kobe-daemon/daemon/platform-shell"
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

  it("wraps --command in the login shell's -ilc, defaults split/right, titles from the command word", async () => {
    const client = new FakeClient({ "tab.open": () => ({ ok: true }) })
    await invokeVerb("pane-open", ["--command", "btop --utf-force"], { client, runtime: stubRuntime() })
    expect(client.requestNames).toEqual(["tab.open"])
    expect(client.requests[0].payload).toEqual({
      taskId: "env-task",
      argv: [resolveLoginShell({ fallback: "/bin/sh" }), "-ilc", "btop --utf-force"],
      title: "btop",
      placement: "split",
      direction: "right",
    })
  })

  it("no --command opens an interactive login shell; explicit flags pass through", async () => {
    const client = new FakeClient({ "tab.open": () => ({ ok: true }) })
    await invokeVerb("pane-open", ["--task-id", "t9", "--direction", "down", "--placement", "tab", "--title", "logs"], {
      client,
      runtime: stubRuntime(),
    })
    const payload = client.requests[0].payload as { taskId: string; argv: string[]; title: string }
    expect(payload.taskId).toBe("t9")
    expect(payload.argv).toEqual([resolveLoginShell({ fallback: "/bin/sh" }), "-il"])
    expect(payload.title).toBe("logs")
    expect(client.requests[0].payload).toMatchObject({ placement: "tab", direction: "down" })
  })

  it("pane-close passes taskId + title over tab.close; --title is required", async () => {
    const client = new FakeClient({ "tab.close": () => ({ ok: true }) })
    await invokeVerb("pane-close", ["--task-id", "t9", "--title", "fx"], { client, runtime: stubRuntime() })
    expect(client.requestNames).toEqual(["tab.close"])
    expect(client.requests[0].payload).toEqual({ taskId: "t9", title: "fx" })
    const bare = new FakeClient()
    await expectApiError(() => invokeVerb("pane-close", [], { client: bare, runtime: stubRuntime() }), "MISSING_FLAG")
    expect(bare.requestNames).toEqual([])
  })

  it("--tab scopes both verbs' payloads to one tab", async () => {
    const client = new FakeClient({ "tab.open": () => ({ ok: true }), "tab.close": () => ({ ok: true }) })
    await invokeVerb("pane-open", ["--task-id", "t9", "--tab", "tab-3", "--command", "btop"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[0].payload).toMatchObject({ taskId: "t9", tabId: "tab-3" })
    await invokeVerb("pane-close", ["--task-id", "t9", "--tab", "tab-3", "--title", "btop"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[1].payload).toEqual({ taskId: "t9", title: "btop", tabId: "tab-3" })
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
