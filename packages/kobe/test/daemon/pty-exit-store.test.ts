/**
 * Durable death records (issue #9): a crashed engine's exit code, signal,
 * time, and last output must survive the PTY host's idle-exit. The store is
 * the persistence half; the host's onSessionExit hook is wired to it in
 * pty-server.ts. Noise rules matter as much as retention — clean exits and
 * the warm spare must never pollute the file.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plainTail, readPtyExitRecords, recordPtyExit } from "@sma1lboy/kobe-daemon/daemon/pty-exit-store"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kobe-pty-exits-"))
  path = join(dir, "pty-exits.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const endInfo = (over: Partial<Parameters<typeof recordPtyExit>[0]> = {}) => ({
  key: "t1::tab-1",
  pid: 4242,
  exit: { code: 1, signal: null, at: "2026-08-11T00:00:00.000Z" },
  tail: "[31mError:[0m config missing\r\nexiting\r\n",
  ...over,
})

describe("pty exit store", () => {
  it("round-trips an abnormal exit with a plain-text tail", () => {
    recordPtyExit(endInfo(), path)
    const records = readPtyExitRecords(path)
    expect(records["t1::tab-1"]).toMatchObject({
      key: "t1::tab-1",
      pid: 4242,
      code: 1,
      signal: null,
      at: "2026-08-11T00:00:00.000Z",
    })
    // ANSI stripped — the record is directly pasteable evidence.
    expect(records["t1::tab-1"]?.tail).toEqual(["Error: config missing", "exiting"])
  })

  it("skips clean exits and the internal warm spare (no-noise rule)", () => {
    recordPtyExit(endInfo({ exit: { code: 0, signal: null, at: "2026-08-11T00:00:00.000Z" } }), path)
    recordPtyExit(endInfo({ key: "::spare", exit: { code: null, signal: "SIGTERM", at: "x" } }), path)
    expect(readPtyExitRecords(path)).toEqual({})
  })

  it("records a signal kill and an unknown cause (both nulls)", () => {
    recordPtyExit(endInfo({ exit: { code: null, signal: "SIGKILL", at: "t" } }), path)
    recordPtyExit(endInfo({ key: "t1::tab-2", exit: { code: null, signal: null, at: "t" } }), path)
    const records = readPtyExitRecords(path)
    expect(records["t1::tab-1"]?.signal).toBe("SIGKILL")
    expect(records["t1::tab-2"]).toMatchObject({ code: null, signal: null })
  })

  it("newest record per key wins, and the file caps at the 50 newest", () => {
    recordPtyExit(endInfo({ exit: { code: 1, signal: null, at: "2026-08-11T00:00:00.000Z" } }), path)
    recordPtyExit(endInfo({ exit: { code: 137, signal: null, at: "2026-08-11T01:00:00.000Z" } }), path)
    expect(readPtyExitRecords(path)["t1::tab-1"]?.code).toBe(137)

    for (let i = 0; i < 60; i++) {
      const at = `2026-08-12T00:00:${String(i).padStart(2, "0")}.000Z`
      recordPtyExit(endInfo({ key: `t2::tab-${i}`, exit: { code: 1, signal: null, at } }), path)
    }
    const records = readPtyExitRecords(path)
    expect(Object.keys(records).length).toBe(50)
    // The oldest (t1::tab-1 and the first t2 tabs) were trimmed; the newest kept.
    expect(records["t1::tab-1"]).toBeUndefined()
    expect(records["t2::tab-59"]).toBeDefined()
  })

  it("a corrupt or missing file reads as empty and recovers on next write", () => {
    expect(readPtyExitRecords(path)).toEqual({})
    writeFileSync(path, "{not json", "utf8")
    expect(readPtyExitRecords(path)).toEqual({})
    recordPtyExit(endInfo(), path)
    expect(readPtyExitRecords(path)["t1::tab-1"]).toBeDefined()
    // And the file itself is valid JSON again.
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow()
  })

  it("plainTail honors CR overwrites, drops trailing blanks, and bounds the tail", () => {
    expect(plainTail("progress 1%\rprogress 99%\r\ndone\r\n\r\n")).toEqual(["progress 99%", "done"])
    const many = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n")
    const tail = plainTail(many)
    expect(tail.length).toBe(40)
    expect(tail[tail.length - 1]).toBe("line-99")
  })
})
