import { describe, expect, it, vi } from "vitest"
import type { EngineQuotaUsage } from "../../../kobe-daemon/src/daemon/contracts.ts"
import type { DaemonEventBus } from "../../../kobe-daemon/src/daemon/event-bus.ts"
import {
  FRESH_POLL_MS,
  MIN_FETCH_INTERVAL_MS,
  QuotaUsageCache,
  RETRY_BASE_MS,
} from "../../../kobe-daemon/src/daemon/quota-usage-cache.ts"
import type { DaemonRuntimeAdapter } from "../../../kobe-daemon/src/daemon/runtime.ts"

const usageAt = (capturedAt: number): EngineQuotaUsage => ({
  windows: [{ kind: "session", label: "5h", percent: 40, resetsAt: capturedAt + 1000 }],
  capturedAt,
})

function harness(results: Array<EngineQuotaUsage | null>) {
  let now = 1_000_000
  const quotaUsage = vi.fn(async () => results.shift() ?? null)
  const published: unknown[] = []
  const cache = new QuotaUsageCache(
    { quotaUsage } as unknown as DaemonRuntimeAdapter,
    { publish: (_c: string, p: unknown) => published.push(p) } as unknown as DaemonEventBus,
    () => now,
  )
  const advance = (ms: number): void => {
    now += ms
  }
  return { cache, quotaUsage, published, advance, nowMs: () => now }
}

describe("QuotaUsageCache.get", () => {
  it("serves a fresh snapshot without fetching", async () => {
    const h = harness([usageAt(1_000_000)])
    await h.cache.get("claude", 0) // first fetch
    h.advance(30_000)
    await h.cache.get("claude", 60_000)
    expect(h.quotaUsage).toHaveBeenCalledTimes(1)
    expect(h.cache.peek("claude")?.capturedAt).toBe(1_000_000)
  })

  it("enforces the per-vendor fetch floor even for maxAge 0 callers", async () => {
    const h = harness([usageAt(1_000_000), usageAt(2_000_000)])
    await h.cache.get("claude", 0)
    h.advance(MIN_FETCH_INTERVAL_MS - 1)
    const second = await h.cache.get("claude", 0) // still floored → cached value
    expect(h.quotaUsage).toHaveBeenCalledTimes(1)
    expect(second?.capturedAt).toBe(1_000_000)
    h.advance(2)
    await h.cache.get("claude", 0) // floor passed → refetch
    expect(h.quotaUsage).toHaveBeenCalledTimes(2)
  })

  it("collapses concurrent callers onto one in-flight fetch", async () => {
    let release: ((u: EngineQuotaUsage | null) => void) | undefined
    const quotaUsage = vi.fn(
      () =>
        new Promise<EngineQuotaUsage | null>((r) => {
          release = r
        }),
    )
    const cache = new QuotaUsageCache(
      { quotaUsage } as unknown as DaemonRuntimeAdapter,
      { publish: () => {} } as unknown as DaemonEventBus,
      () => 1_000_000,
    )
    const [a, b] = [cache.get("claude", 0), cache.get("claude", 0)]
    release?.(usageAt(1_000_000))
    expect((await a)?.capturedAt).toBe(1_000_000)
    expect((await b)?.capturedAt).toBe(1_000_000)
    expect(quotaUsage).toHaveBeenCalledTimes(1)
  })
})

describe("QuotaUsageCache.refreshIfDue", () => {
  it("polls slowly once a snapshot exists", async () => {
    const h = harness([usageAt(1_000_000), usageAt(9_999_999)])
    await h.cache.refreshIfDue("claude")
    expect(h.quotaUsage).toHaveBeenCalledTimes(1)
    h.advance(FRESH_POLL_MS - 1000)
    await h.cache.refreshIfDue("claude") // not due yet
    expect(h.quotaUsage).toHaveBeenCalledTimes(1)
    h.advance(2000)
    await h.cache.refreshIfDue("claude") // slow interval passed
    expect(h.quotaUsage).toHaveBeenCalledTimes(2)
  })

  it("backs off exponentially while fetches fail, capped at the slow interval", async () => {
    const h = harness([null, null, null])
    await h.cache.refreshIfDue("claude") // failure #1
    h.advance(RETRY_BASE_MS - 1000)
    await h.cache.refreshIfDue("claude") // 1× base not yet elapsed
    expect(h.quotaUsage).toHaveBeenCalledTimes(1)
    h.advance(2000)
    await h.cache.refreshIfDue("claude") // failure #2
    expect(h.quotaUsage).toHaveBeenCalledTimes(2)
    h.advance(RETRY_BASE_MS + 1000)
    await h.cache.refreshIfDue("claude") // 2× base not yet elapsed (backoff doubled)
    expect(h.quotaUsage).toHaveBeenCalledTimes(2)
    h.advance(RETRY_BASE_MS)
    await h.cache.refreshIfDue("claude") // failure #3 after full 2× base
    expect(h.quotaUsage).toHaveBeenCalledTimes(3)
  })

  it("publishes the full vendor map only when a snapshot changes", async () => {
    const changed: EngineQuotaUsage = {
      windows: [{ kind: "session", label: "5h", percent: 41, resetsAt: null }],
      capturedAt: 2_000_000,
    }
    const h = harness([usageAt(1_000_000), { ...usageAt(1_000_000), capturedAt: 1_500_000 }, changed])
    await h.cache.refreshIfDue("claude")
    expect(h.published).toEqual([{ usage: { claude: usageAt(1_000_000) } }])
    h.advance(FRESH_POLL_MS + 1)
    await h.cache.refreshIfDue("claude") // same windows, only capturedAt moved → no publish
    expect(h.published).toHaveLength(1)
    h.advance(FRESH_POLL_MS + 1)
    await h.cache.refreshIfDue("claude") // windows changed → publish
    expect(h.published).toHaveLength(2)
    expect(h.published[1]).toEqual({ usage: { claude: changed } })
  })
})
