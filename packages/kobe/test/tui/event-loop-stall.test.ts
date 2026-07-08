import { describe, expect, it } from "vitest"
import { STALL_HEARTBEAT_MS, STALL_THRESHOLD_MS, stallReport } from "../../src/tui/lib/event-loop-stall"

// Why this matters: the stall report is the incident-forensics primitive for
// "the TUI froze" reports (2026-07-07/08 — we could never tell OS paging
// apart from an in-process block after the fact). The threshold branch and
// the MB math are the whole contract; if either drifts, the log line lies.
describe("stallReport", () => {
  const mem = { rss: 300 * 1048576, heapUsed: 120 * 1048576 }

  it("stays silent for an on-time or mildly late beat", () => {
    expect(stallReport(STALL_HEARTBEAT_MS, mem)).toBeNull()
    expect(stallReport(STALL_HEARTBEAT_MS + STALL_THRESHOLD_MS - 1, mem)).toBeNull()
  })

  it("reports the stall duration (gap minus heartbeat) with heap numbers", () => {
    const report = stallReport(STALL_HEARTBEAT_MS + 5000, mem)
    expect(report).toBe("event loop stalled ~5000ms — rss=300MB heapUsed=120MB")
  })

  it("honours injected heartbeat/threshold overrides", () => {
    expect(stallReport(250, mem, 100, 100)).toContain("~150ms")
    expect(stallReport(199, mem, 100, 100)).toBeNull()
  })
})
