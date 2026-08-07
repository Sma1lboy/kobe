import { EngineSessionMonitor } from "@sma1lboy/kobe-daemon/daemon/engine-session-monitor"
import { describe, expect, it, vi } from "vitest"

function monitorHarness(
  observe: ReturnType<typeof vi.fn>,
  options: {
    getTask?: () => unknown
    now?: () => number
    leaseMs?: number
  } = {},
) {
  const bind = vi.fn(async () => ({}))
  const markTransition = vi.fn()
  const pinTabSession = vi.fn()
  const monitor = new EngineSessionMonitor(
    { getTask: options.getTask ?? (() => ({ id: "task-1" })) } as never,
    { observeEngineSessionActivation: observe } as never,
    { bind, markTransition } as never,
    { pinTabSession },
    {
      pollMs: 60_000,
      ...(options.now ? { now: options.now } : {}),
      ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    },
  )
  return { monitor, bind, markTransition, pinTabSession }
}

describe("EngineSessionMonitor", () => {
  it("keeps observing one PTY across pending and selected resume phases", async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({ phase: "pending", source: "resume", observedAt: 101, cursor: "1" })
      .mockResolvedValueOnce({
        phase: "selected",
        source: "resume",
        observedAt: 102,
        cursor: "2",
        sessionId: "session-2",
        transcriptPath: "/tmp/session-2.jsonl",
      })
    const { monitor, bind, markTransition, pinTabSession } = monitorHarness(observe)
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 42, startedAt: 100 })
    await vi.waitFor(() => expect(markTransition).toHaveBeenCalledOnce())
    await monitor.tick()

    expect(observe).toHaveBeenNthCalledWith(1, "codex", 42, 100, undefined)
    expect(observe).toHaveBeenNthCalledWith(2, "codex", 42, 100, "1")
    expect(bind).toHaveBeenCalledWith({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "session-2",
      source: "observer",
      startSource: "resume",
      transcriptPath: "/tmp/session-2.jsonl",
    })
    expect(pinTabSession).toHaveBeenCalledWith("task-1", "tab-a", "session-2")
    expect(monitor.size()).toBe(1)
    monitor.close()
  })

  it("does not let an old PID unregister its replacement", () => {
    const { monitor } = monitorHarness(vi.fn(async () => null))
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 1, startedAt: 100 })
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 2, startedAt: 200 })
    expect(monitor.unwatch({ taskId: "task-1", tabId: "tab-a", rootPid: 1 })).toBe(false)
    expect(monitor.size()).toBe(1)
    expect(monitor.unwatch({ taskId: "task-1", tabId: "tab-a", rootPid: 2 })).toBe(true)
    monitor.close()
  })

  it("ignores a delayed heartbeat from an older process incarnation", () => {
    const { monitor } = monitorHarness(vi.fn(async () => null))
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 2, startedAt: 200 })
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 1, startedAt: 100 })

    expect(monitor.unwatch({ taskId: "task-1", tabId: "tab-a", rootPid: 1 })).toBe(false)
    expect(monitor.unwatch({ taskId: "task-1", tabId: "tab-a", rootPid: 2 })).toBe(true)
    monitor.close()
  })

  it("replaces a stale watch when the OS reuses the same PID", async () => {
    const observe = vi.fn(async () => null)
    const { monitor } = monitorHarness(observe)
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 2, startedAt: 100 })
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce())

    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 2, startedAt: 200 })
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2))

    expect(observe).toHaveBeenNthCalledWith(2, "codex", 2, 200, undefined)
    monitor.close()
  })

  it("drops a stale async activation after the watched process is replaced", async () => {
    let resolveOld: ((value: unknown) => void) | undefined
    const observe = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValueOnce({
        phase: "selected",
        source: "resume",
        observedAt: 202,
        cursor: "2",
        sessionId: "session-new",
      })
    const { monitor, bind } = monitorHarness(observe)
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 1, startedAt: 100 })
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce())
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 2, startedAt: 200 })
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce())

    resolveOld?.({
      phase: "selected",
      source: "resume",
      observedAt: 102,
      cursor: "1",
      sessionId: "session-old",
    })
    await Promise.resolve()

    expect(bind).toHaveBeenCalledTimes(1)
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-new" }))
    monitor.close()
  })

  it("expires a watch whose sidecar lease stops heartbeating", async () => {
    let now = 100
    const { monitor } = monitorHarness(
      vi.fn(async () => null),
      { now: () => now, leaseMs: 10 },
    )
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 1, startedAt: 100 })
    expect(monitor.size()).toBe(1)
    now = 111
    await monitor.tick()
    expect(monitor.size()).toBe(0)
    monitor.close()
  })

  it("stops watching when its task no longer exists", async () => {
    const { monitor } = monitorHarness(
      vi.fn(async () => null),
      { getTask: () => undefined },
    )
    monitor.watch({ taskId: "deleted", tabId: "tab-a", vendor: "codex", rootPid: 1, startedAt: 100 })
    await vi.waitFor(() => expect(monitor.size()).toBe(0))
    monitor.close()
  })

  it("retries a selected activation when durable binding fails", async () => {
    const observe = vi.fn(async () => ({
      phase: "selected" as const,
      source: "resume" as const,
      observedAt: 102,
      cursor: "2",
      sessionId: "session-2",
    }))
    const { monitor, bind } = monitorHarness(observe)
    bind.mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValueOnce({})
    monitor.watch({ taskId: "task-1", tabId: "tab-a", vendor: "codex", rootPid: 42, startedAt: 100 })
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce())
    await monitor.tick()

    expect(observe).toHaveBeenNthCalledWith(2, "codex", 42, 100, undefined)
    expect(bind).toHaveBeenCalledTimes(2)
    monitor.close()
  })
})
