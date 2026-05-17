/**
 * Daemon-side poller that periodically refreshes the Claude plan-usage
 * snapshot and notifies a single subscriber (the daemon's broadcast hook).
 *
 * One poller per daemon instance. The orchestrator deliberately does not
 * own this — plan usage is account-scoped (independent of tasks/tabs) and
 * cheap to re-fetch from any process that can read claude-code's token.
 *
 * Multi-attached TUIs share the daemon's snapshot via broadcast + hello
 * seed, so we never multiply the request rate by the number of clients.
 */

import { fetchPlanUsage } from "../engine/claude-code-local/plan-usage.ts"
import type { PlanUsage } from "../types/plan-usage.ts"
import { logDaemonError } from "./crash-log.ts"

const DEFAULT_INTERVAL_MS = 60_000

export interface PlanUsagePoller {
  start(): void
  stop(): void
  current(): PlanUsage | null
  refresh(): Promise<void>
}

export interface PlanUsagePollerOptions {
  /** Tick interval. Defaults to 60s. */
  readonly intervalMs?: number
  /** Called with each successful snapshot (never with `null`). */
  readonly onUpdate: (usage: PlanUsage) => void
  /** Test seam: replace the fetcher (e.g. a fake that returns canned data). */
  readonly fetcher?: () => Promise<PlanUsage | null>
}

export function createPlanUsagePoller(options: PlanUsagePollerOptions): PlanUsagePoller {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const fetcher = options.fetcher ?? fetchPlanUsage
  let timer: ReturnType<typeof setInterval> | null = null
  let last: PlanUsage | null = null
  let inflight = false

  async function tick(): Promise<void> {
    if (inflight) return
    inflight = true
    try {
      const usage = await fetcher()
      if (usage) {
        last = usage
        options.onUpdate(usage)
      }
    } catch (err) {
      // A poll failure (network, token read, claude API hiccup) is
      // best-effort — keep the last snapshot and try again next tick.
      // Catch HERE so the failure is logged against `plan-usage-poller`
      // instead of escaping `void tick()` as an anonymous unhandled
      // rejection that the crash net can only label generically.
      logDaemonError("plan-usage-poller", err)
    } finally {
      inflight = false
    }
  }

  return {
    start(): void {
      if (timer) return
      void tick()
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
    },
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    current(): PlanUsage | null {
      return last
    },
    async refresh(): Promise<void> {
      await tick()
    },
  }
}
