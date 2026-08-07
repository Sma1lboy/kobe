import { describe, expect, it, vi } from "vitest"
import type { EngineHistoryReader } from "../../src/engine/registry.ts"
import { TraceSnapshotMonitor } from "../../src/web/trace-snapshot-monitor.ts"

describe("TraceSnapshotMonitor", () => {
  it("shares one history read across subscribers and tears down when the last leaves", async () => {
    const revision = vi.fn(async () => 1)
    const readTrace = vi.fn(async (sessionId: string) => ({ sessionId, turns: [] }))
    const monitor = new TraceSnapshotMonitor(
      () => ({ traceRevision: revision, readTrace }) as unknown as EngineHistoryReader,
      60_000,
    )
    const a = vi.fn()
    const b = vi.fn()
    const offA = monitor.subscribe("codex", "session-1", { trace: a, error: vi.fn() })
    const offB = monitor.subscribe("codex", "session-1", { trace: b, error: vi.fn() })
    await vi.waitFor(() => expect(a).toHaveBeenCalledOnce())

    expect(revision).toHaveBeenCalledOnce()
    expect(readTrace).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledWith({ sessionId: "session-1", turns: [] }, 1)
    expect(monitor.size()).toBe(1)
    offA()
    expect(monitor.size()).toBe(1)
    offB()
    expect(monitor.size()).toBe(0)
  })

  it("broadcasts only when the shared revision advances", async () => {
    let currentRevision = 1
    const readTrace = vi.fn(async (sessionId: string) => ({ sessionId, turns: [] }))
    const monitor = new TraceSnapshotMonitor(
      () => ({ traceRevision: async () => currentRevision, readTrace }) as unknown as EngineHistoryReader,
      60_000,
    )
    const trace = vi.fn()
    const off = monitor.subscribe("codex", "session-1", { trace, error: vi.fn() })
    await vi.waitFor(() => expect(trace).toHaveBeenCalledOnce())
    await monitor.tick()
    expect(readTrace).toHaveBeenCalledOnce()
    currentRevision = 2
    await monitor.tick()
    expect(readTrace).toHaveBeenCalledTimes(2)
    expect(trace).toHaveBeenCalledTimes(2)
    off()
  })

  it("serves a late subscriber from the cached full snapshot", async () => {
    const readTrace = vi.fn(async (sessionId: string) => ({ sessionId, turns: [] }))
    const monitor = new TraceSnapshotMonitor(
      () => ({ traceRevision: async () => 1, readTrace }) as unknown as EngineHistoryReader,
      60_000,
    )
    const first = vi.fn()
    const offFirst = monitor.subscribe("codex", "session-1", { trace: first, error: vi.fn() })
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())

    const late = vi.fn()
    const offLate = monitor.subscribe("codex", "session-1", { trace: late, error: vi.fn() })
    expect(late).toHaveBeenCalledWith({ sessionId: "session-1", turns: [] }, 1)
    expect(readTrace).toHaveBeenCalledOnce()
    offFirst()
    offLate()
  })

  it("recovers on the next poll after a transient history error", async () => {
    const revision = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValue(1)
    const readTrace = vi.fn(async (sessionId: string) => ({ sessionId, turns: [] }))
    const monitor = new TraceSnapshotMonitor(
      () => ({ traceRevision: revision, readTrace }) as unknown as EngineHistoryReader,
      60_000,
    )
    const trace = vi.fn()
    const error = vi.fn()
    const off = monitor.subscribe("codex", "session-1", { trace, error })
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())

    await monitor.tick()
    expect(trace).toHaveBeenCalledWith({ sessionId: "session-1", turns: [] }, 1)
    off()
  })

  it("keeps sessions isolated when their revisions advance independently", async () => {
    const revisions = new Map([
      ["session-a", 1],
      ["session-b", 1],
    ])
    const reader = {
      traceRevision: async (sessionId: string) => revisions.get(sessionId) ?? 0,
      readTrace: async (sessionId: string) => ({ sessionId, turns: [] }),
    } as unknown as EngineHistoryReader
    const monitor = new TraceSnapshotMonitor(() => reader, 60_000)
    const a = vi.fn()
    const b = vi.fn()
    const offA = monitor.subscribe("codex", "session-a", { trace: a, error: vi.fn() })
    const offB = monitor.subscribe("codex", "session-b", { trace: b, error: vi.fn() })
    await vi.waitFor(() => {
      expect(a).toHaveBeenCalledOnce()
      expect(b).toHaveBeenCalledOnce()
    })

    revisions.set("session-a", 2)
    await monitor.tick()
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledOnce()
    offA()
    offB()
  })
})
