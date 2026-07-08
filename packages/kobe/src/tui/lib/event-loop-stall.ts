/**
 * Event-loop stall telemetry (incident 2026-07-07/08): when the TUI
 * "freezes" we could never tell after the fact whether the event loop was
 * blocked by JS (a kobe bug — sample would show the stack) or the whole
 * process was paged out under memory pressure (an OS-level stall — nothing
 * in-process is at fault). A 1s heartbeat measures wall-clock drift; when a
 * beat arrives far later than scheduled, the gap IS the stall, and the log
 * line carries heap numbers so the next freeze report starts with ground
 * truth instead of inference.
 *
 * Interpretation guide for the log line:
 *   - big gap + rss far above heapUsed → process was swapped/paged (OS)
 *   - big gap + heapUsed near rss      → suspect in-process work; `sample`
 *     the pid during the next stall to get the stack
 */
import { logClient } from "@sma1lboy/kobe-daemon/client/client-log"

export const STALL_HEARTBEAT_MS = 1000
export const STALL_THRESHOLD_MS = 2000

/** Pure decision + message builder, unit-testable without timers. */
export function stallReport(
  gapMs: number,
  mem: { rss: number; heapUsed: number },
  heartbeatMs: number = STALL_HEARTBEAT_MS,
  thresholdMs: number = STALL_THRESHOLD_MS,
): string | null {
  const stallMs = gapMs - heartbeatMs
  if (stallMs < thresholdMs) return null
  const mb = (n: number) => Math.round(n / 1048576)
  return `event loop stalled ~${stallMs}ms — rss=${mb(mem.rss)}MB heapUsed=${mb(mem.heapUsed)}MB`
}

/**
 * Start the heartbeat. Returns a stop function; the timer is unref'd so it
 * never keeps a dying host alive.
 */
export function installEventLoopStallTelemetry(): () => void {
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const gap = now - last
    last = now
    const report = stallReport(gap, process.memoryUsage())
    if (report) logClient("stall", report)
  }, STALL_HEARTBEAT_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
