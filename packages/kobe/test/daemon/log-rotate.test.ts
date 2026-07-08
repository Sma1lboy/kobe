/**
 * Tests for the append-log rotation logic (issue #26): `~/.kobe/client.log`
 * grew to 736MB and `~/.kobe/daemon.log` to 345MB with no cap. These lock
 * the pure size-threshold decision plus the real rename-based rotation
 * against a temp dir (never the real ~/.kobe).
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_LOG_ROTATE_CAP_BYTES,
  rotateLogIfNeeded,
  shouldRotateLog,
} from "@sma1lboy/kobe-daemon/daemon/log-rotate"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

describe("shouldRotateLog", () => {
  test("false at and under the cap", () => {
    expect(shouldRotateLog(0, 100)).toBe(false)
    expect(shouldRotateLog(100, 100)).toBe(false)
  })

  test("true once strictly over the cap", () => {
    expect(shouldRotateLog(101, 100)).toBe(true)
  })

  test("defaults to a 10MB cap", () => {
    expect(DEFAULT_LOG_ROTATE_CAP_BYTES).toBe(10 * 1024 * 1024)
    expect(shouldRotateLog(DEFAULT_LOG_ROTATE_CAP_BYTES)).toBe(false)
    expect(shouldRotateLog(DEFAULT_LOG_ROTATE_CAP_BYTES + 1)).toBe(true)
  })
})

describe("rotateLogIfNeeded", () => {
  let dir: string
  let logPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-log-rotate-"))
    logPath = join(dir, "test.log")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("no-op when the file doesn't exist yet", () => {
    expect(() => rotateLogIfNeeded(logPath, 100)).not.toThrow()
  })

  test("no-op when the file is under the cap", async () => {
    await writeFile(logPath, "a".repeat(50))
    rotateLogIfNeeded(logPath, 100)
    const { size } = await stat(logPath)
    expect(size).toBe(50)
    await expect(stat(`${logPath}.old`)).rejects.toThrow()
  })

  test("renames to <path>.old and leaves no file at the original path when over cap", async () => {
    await writeFile(logPath, "a".repeat(150))
    rotateLogIfNeeded(logPath, 100)
    await expect(stat(logPath)).rejects.toThrow()
    const { size } = await stat(`${logPath}.old`)
    expect(size).toBe(150)
  })

  test("clobbers a previous .old generation — only one kept", async () => {
    await writeFile(`${logPath}.old`, "stale generation")
    await writeFile(logPath, "a".repeat(150))
    rotateLogIfNeeded(logPath, 100)
    const { size } = await stat(`${logPath}.old`)
    expect(size).toBe(150) // the fresh rotation, not the stale content
  })
})
