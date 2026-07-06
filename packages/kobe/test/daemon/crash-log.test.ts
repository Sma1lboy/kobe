import {
  formatCrashEntry,
  formatDaemonError,
  installDaemonCrashHandlers,
  logDaemonError,
  resetDaemonCrashHandlersForTest,
} from "@sma1lboy/kobe-daemon/daemon/crash-log"
import { afterEach, describe, expect, test, vi } from "vitest"

afterEach(() => {
  resetDaemonCrashHandlersForTest()
})

describe("formatCrashEntry", () => {
  test("renders kind, ISO timestamp, and the error stack", () => {
    const at = new Date("2026-05-17T12:00:00.000Z")
    const line = formatCrashEntry("uncaughtException", new Error("kaboom"), at)
    expect(line).toContain("2026-05-17T12:00:00.000Z")
    expect(line).toContain("daemon uncaughtException")
    expect(line).toContain("kaboom")
    expect(line.endsWith("\n")).toBe(true)
  })

  test("wraps a non-Error rejection reason into something printable", () => {
    const line = formatCrashEntry("unhandledRejection", "plain string reason")
    expect(line).toContain("daemon unhandledRejection")
    expect(line).toContain("plain string reason")
  })

  test("survives a reason that cannot be JSON-stringified", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => formatCrashEntry("unhandledRejection", circular)).not.toThrow()
  })
})

describe("formatDaemonError", () => {
  test("tags the line with the subsystem so daemon.log points at the failing area", () => {
    const at = new Date("2026-05-17T12:00:00.000Z")
    const line = formatDaemonError("plan-usage-poller", new Error("fetch failed"), at)
    expect(line).toContain("2026-05-17T12:00:00.000Z")
    expect(line).toContain("daemon error [plan-usage-poller]")
    expect(line).toContain("fetch failed")
    expect(line.endsWith("\n")).toBe(true)
  })

  test("coerces a non-Error reason into printable text", () => {
    const line = formatDaemonError("rc-bridge", { code: "EPIPE" })
    expect(line).toContain("daemon error [rc-bridge]")
    expect(line).toContain("EPIPE")
  })

  test("logDaemonError writes the tagged line to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      logDaemonError("daemon-shutdown", new Error("close hung"))
      const written = spy.mock.calls.map((c) => String(c[0])).join("")
      expect(written).toContain("daemon error [daemon-shutdown]")
      expect(written).toContain("close hung")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("installDaemonCrashHandlers", () => {
  test("registers exactly one handler for each fatal process event", () => {
    resetDaemonCrashHandlersForTest()
    const rejectionsBefore = process.listenerCount("unhandledRejection")
    const exceptionsBefore = process.listenerCount("uncaughtException")

    installDaemonCrashHandlers(() => {})

    expect(process.listenerCount("unhandledRejection")).toBe(rejectionsBefore + 1)
    expect(process.listenerCount("uncaughtException")).toBe(exceptionsBefore + 1)
  })

  test("is idempotent — a second call does not stack duplicate handlers", () => {
    resetDaemonCrashHandlersForTest()
    installDaemonCrashHandlers(() => {})
    const rejections = process.listenerCount("unhandledRejection")
    const exceptions = process.listenerCount("uncaughtException")

    installDaemonCrashHandlers(() => {})

    expect(process.listenerCount("unhandledRejection")).toBe(rejections)
    expect(process.listenerCount("uncaughtException")).toBe(exceptions)
  })

  test("the registered unhandledRejection handler logs through the injected sink", () => {
    const lines: string[] = []
    resetDaemonCrashHandlersForTest()
    const before = process.listeners("unhandledRejection")
    installDaemonCrashHandlers((l) => lines.push(l))
    const added = process.listeners("unhandledRejection").filter((h) => !before.includes(h))
    expect(added).toHaveLength(1)
    ;(added[0] as (reason: unknown) => void)(new Error("stray rejection"))
    expect(lines.some((l) => l.includes("unhandledRejection") && l.includes("stray rejection"))).toBe(true)
  })

  test("resetDaemonCrashHandlersForTest removes exactly the handlers it installed", () => {
    resetDaemonCrashHandlersForTest()
    const rejectionsBaseline = process.listenerCount("unhandledRejection")
    const exceptionsBaseline = process.listenerCount("uncaughtException")

    installDaemonCrashHandlers(() => {})
    resetDaemonCrashHandlersForTest()

    expect(process.listenerCount("unhandledRejection")).toBe(rejectionsBaseline)
    expect(process.listenerCount("uncaughtException")).toBe(exceptionsBaseline)
  })
})
