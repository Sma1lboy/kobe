/**
 * Daemon-owned cache in front of the engine quota probes. The vendor usage
 * APIs are themselves rate-limited, so the cache is the ONLY caller of
 * `runtime.quotaUsage(vendor)` and enforces the whole cadence policy:
 *
 *  - Have a snapshot → refresh slowly ({@link FRESH_POLL_MS}).
 *  - No snapshot yet / last fetch failed → retry with exponential backoff
 *    from {@link RETRY_BASE_MS}, capped at the slow interval — so a vendor
 *    that can't answer (no login, endpoint down) is still re-tried
 *    eventually, but never hammered.
 *  - A hard floor ({@link MIN_FETCH_INTERVAL_MS}) between attempts per
 *    vendor, regardless of who asks — an event storm of rate-limit hooks
 *    collapses onto one fetch.
 *  - Concurrent callers share one in-flight fetch per vendor.
 *
 * Memory is strictly bounded: one entry per vendor id ever seen (a handful),
 * each holding one snapshot object — no histories, no growing arrays. The
 * event bus's last-value slot for `usage.snapshot` is likewise a single map.
 */

import type { EngineQuotaUsage, VendorId } from "./contracts.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

/** Refresh interval while a snapshot exists (usage moves slowly for display). */
export const FRESH_POLL_MS = 15 * 60 * 1000
/** First-retry delay when there is no snapshot (doubles per failure). */
export const RETRY_BASE_MS = 60 * 1000
/** Hard floor between fetch attempts for one vendor, whatever the caller. */
export const MIN_FETCH_INTERVAL_MS = 60 * 1000

interface VendorEntry {
  usage: EngineQuotaUsage | null
  /** Epoch ms of the last fetch ATTEMPT (success or not) — cadence gate. */
  attemptedAt: number
  /** Consecutive failed/empty fetches since the last success — backoff input. */
  failures: number
  inFlight: Promise<EngineQuotaUsage | null> | null
}

export class QuotaUsageCache {
  private readonly entries = new Map<string, VendorEntry>()

  constructor(
    private readonly runtime: DaemonRuntimeAdapter,
    private readonly bus: DaemonEventBus,
    private readonly now: () => number = Date.now,
  ) {}

  /** Latest cached snapshot for a vendor (no fetch), or null. */
  peek(vendor: VendorId): EngineQuotaUsage | null {
    return this.entries.get(vendor)?.usage ?? null
  }

  /**
   * Cached snapshot, refreshed first when older than `maxAgeMs` AND the
   * per-vendor fetch floor allows. Callers that tolerate stale data pass a
   * large `maxAgeMs`; the rate-limit scheduler passes a small one and still
   * cannot push the vendor API past one request per {@link MIN_FETCH_INTERVAL_MS}.
   */
  async get(vendor: VendorId, maxAgeMs: number): Promise<EngineQuotaUsage | null> {
    const entry = this.entry(vendor)
    const age = this.now() - (entry.usage?.capturedAt ?? 0)
    if (entry.usage && age <= maxAgeMs) return entry.usage
    if (entry.inFlight) return entry.inFlight
    if (this.now() - entry.attemptedAt < MIN_FETCH_INTERVAL_MS) return entry.usage
    return this.fetch(vendor, entry)
  }

  /**
   * Poller tick entry: refresh when the adaptive schedule says the vendor is
   * due — slow while data exists, backing-off retries while it doesn't.
   */
  async refreshIfDue(vendor: VendorId): Promise<void> {
    const entry = this.entry(vendor)
    // 1× base after the first failure, doubling per further failure, capped
    // at the slow interval; a never-attempted vendor (attemptedAt 0) is due.
    const retryAfter = entry.failures === 0 ? 0 : Math.min(RETRY_BASE_MS * 2 ** (entry.failures - 1), FRESH_POLL_MS)
    const dueAfter = entry.usage ? FRESH_POLL_MS : retryAfter
    if (this.now() - entry.attemptedAt < dueAfter) return
    await this.fetch(vendor, entry)
  }

  private entry(vendor: VendorId): VendorEntry {
    const existing = this.entries.get(vendor)
    if (existing) return existing
    const fresh: VendorEntry = { usage: null, attemptedAt: 0, failures: 0, inFlight: null }
    this.entries.set(vendor, fresh)
    return fresh
  }

  private fetch(vendor: VendorId, entry: VendorEntry): Promise<EngineQuotaUsage | null> {
    if (entry.inFlight) return entry.inFlight
    entry.attemptedAt = this.now()
    entry.inFlight = this.runtime
      .quotaUsage(vendor)
      .catch(() => null)
      .then((usage) => {
        entry.inFlight = null
        if (usage) {
          entry.failures = 0
          const changed = JSON.stringify(usage.windows) !== JSON.stringify(entry.usage?.windows)
          entry.usage = usage
          if (changed) this.publish()
        } else {
          entry.failures += 1
        }
        return entry.usage
      })
    return entry.inFlight
  }

  /** Full-map-replace publish of every vendor that has a snapshot. */
  private publish(): void {
    const usage: Record<string, EngineQuotaUsage> = {}
    for (const [vendor, entry] of this.entries) {
      if (entry.usage) usage[vendor] = entry.usage
    }
    this.bus.publish("usage.snapshot", { usage })
  }
}

/**
 * The usage poller: one cheap interval that asks the cache to refresh the
 * vendors currently in play (task vendors + the default). Skips entirely
 * while no GUI is attached — the dashboard is the only poll consumer; the
 * rate-limit scheduler does its own on-demand `get`. All real cadence
 * control lives in the cache, so a fast tick here costs comparisons only.
 */
export function startQuotaUsagePoller(
  cache: QuotaUsageCache,
  listVendors: () => readonly VendorId[],
  hasSubscribers: () => boolean,
  tickMs: number = MIN_FETCH_INTERVAL_MS,
): () => void {
  const tick = (): void => {
    if (!hasSubscribers()) return
    for (const vendor of new Set(listVendors())) void cache.refreshIfDue(vendor)
  }
  tick()
  const timer = setInterval(tick, tickMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
