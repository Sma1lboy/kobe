import { describe, expect, it, vi } from "vitest"
import { createEngineSessionObservationClient } from "../engine-session-observer.mjs"

describe("engine session observation client", () => {
  it("registers immediately and heartbeats the same process identity", async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}"))
    const client = createEngineSessionObservationClient({
      daemonWebPort: 5176,
      fetchFn,
      heartbeatMs: 50,
    })
    client.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 4242, startedAt: 100 })
    await vi.advanceTimersByTimeAsync(50)

    expect(fetchFn).toHaveBeenCalledTimes(2)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:5176/api/rpc")
    expect(JSON.parse(init.body)).toEqual({
      name: "engine.watchSession",
      payload: { taskId: "task-1", tabId: "tab-a", rootPid: 4242, vendor: "codex", startedAt: 100 },
    })
    client.close()
    vi.useRealTimers()
  })

  it("replaces a tab watch and unregisters the prior PID", async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}"))
    const client = createEngineSessionObservationClient({ daemonWebPort: 5176, fetchFn, heartbeatMs: 50 })
    client.watch({ taskId: "task-1", tabId: "tab-a", rootPid: 1, startedAt: 100 })
    client.watch({ taskId: "task-1", tabId: "tab-a", rootPid: 2, startedAt: 200 })
    await Promise.resolve()
    expect(fetchFn.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { name: "engine.watchSession", payload: { taskId: "task-1", tabId: "tab-a", rootPid: 1, startedAt: 100 } },
      { name: "engine.unwatchSession", payload: { taskId: "task-1", tabId: "tab-a", rootPid: 1 } },
      { name: "engine.watchSession", payload: { taskId: "task-1", tabId: "tab-a", rootPid: 2, startedAt: 200 } },
    ])
    client.close()
    vi.useRealTimers()
  })

  it("ignores a stale PID-specific unwatch", async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}"))
    const client = createEngineSessionObservationClient({ daemonWebPort: 5176, fetchFn, heartbeatMs: 50 })
    client.watch({ taskId: "task-1", tabId: "tab-a", rootPid: 2, startedAt: 200 })
    client.unwatch("tab-a", 1)
    expect(client.watchedCount()).toBe(1)
    client.unwatch("tab-a", 2)
    expect(client.watchedCount()).toBe(0)
    vi.useRealTimers()
  })

  it("retries registration by heartbeat after the daemon is unavailable", async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error("daemon restarting")).mockResolvedValue(new Response("{}"))
    const client = createEngineSessionObservationClient({ daemonWebPort: 5176, fetchFn, heartbeatMs: 50 })
    client.watch({ taskId: "task-1", tabId: "tab-a", rootPid: 2, startedAt: 200 })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(50)

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toMatchObject({ name: "engine.watchSession" })
    client.close()
    vi.useRealTimers()
  })

  it("unregisters every watched tab and stops heartbeats on close", async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}"))
    const client = createEngineSessionObservationClient({ daemonWebPort: 5176, fetchFn, heartbeatMs: 50 })
    client.watch({ taskId: "task-1", tabId: "tab-a", rootPid: 1, startedAt: 100 })
    client.watch({ taskId: "task-1", tabId: "tab-b", rootPid: 2, startedAt: 200 })
    client.close()
    const callsAtClose = fetchFn.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)

    expect(client.watchedCount()).toBe(0)
    expect(fetchFn).toHaveBeenCalledTimes(callsAtClose)
    expect(fetchFn.mock.calls.map((call) => JSON.parse(call[1].body).name)).toEqual([
      "engine.watchSession",
      "engine.watchSession",
      "engine.unwatchSession",
      "engine.unwatchSession",
    ])
    vi.useRealTimers()
  })
})
