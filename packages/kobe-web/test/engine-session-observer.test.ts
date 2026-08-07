import { describe, expect, it, vi } from "vitest"
import { createEngineSessionObservationClient } from "../engine-session-observer.mjs"

describe("engine session observation client", () => {
  it("retries a neutral PID-scoped observation after a terminal commit", async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}"))
    const client = createEngineSessionObservationClient({
      daemonWebPort: 5176,
      fetchFn,
      delaysMs: [0, 50],
    })
    client.observe({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 4242 })
    await vi.runAllTimersAsync()

    expect(fetchFn).toHaveBeenCalledTimes(2)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:5176/api/rpc")
    expect(JSON.parse(init.body)).toEqual({
      name: "engine.observeSession",
      payload: { taskId: "task-1", tabId: "tab-a", rootPid: 4242, vendor: "codex" },
    })
    vi.useRealTimers()
  })

  it("supersedes the prior retry window for the same tab", async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}"))
    const client = createEngineSessionObservationClient({ daemonWebPort: 5176, fetchFn, delaysMs: [50] })
    client.observe({ taskId: "task-1", tabId: "tab-a", rootPid: 1 })
    client.observe({ taskId: "task-1", tabId: "tab-a", rootPid: 2 })
    await vi.runAllTimersAsync()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).payload.rootPid).toBe(2)
    vi.useRealTimers()
  })
})
