/**
 * Tests for the daemon crash net.
 *
 * Regression target: the daemon used to "die easily" — it ran with no
 * `unhandledRejection` / `uncaughtException` handler, so a single stray
 * rejected promise from one of its fire-and-forget `void someAsync()`
 * calls terminated the whole process (Node/Bun's default). Registering
 * the handlers flips that default to "log and keep serving."
 *
 * These tests invoke the registered listener functions directly rather
 * than `process.emit(...)`, so the vitest runner's own process-level
 * listeners are never triggered.
 */

import { formatCrashEntry, installDaemonCrashHandlers, resetDaemonCrashHandlersForTest } from "@/daemon/crash-log"
import { afterEach, describe, expect, test } from "vitest"

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

    // Invoke our handler directly — proves a stray rejection becomes a
    // logged line instead of a process kill.
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
