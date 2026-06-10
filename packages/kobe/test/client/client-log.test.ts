import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  flushClientLog,
  formatClientEntry,
  logClient,
  setClientLogContext,
} from "@sma1lboy/kobe-daemon/client/client-log"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * The client log is the observability that was MISSING when the Tasks-pane
 * sync drift went undiagnosed: a pane in an opentui alternate-screen has no
 * visible stdout, so its disconnect churn left no trace. These lock the line
 * format (context + pid + subsystem tag) and that a real write lands on disk
 * under the KOBE_HOME_DIR-isolated `.kobe/client.log`.
 */
describe("client-log", () => {
  it("formats a line with context, pid, and subsystem tag", () => {
    setClientLogContext("tasks")
    const at = new Date("2026-06-03T12:00:00.000Z")
    const line = formatClientEntry("orch", "subscribed as pane (3 tasks)", at)
    expect(line).toBe(
      `[2026-06-03T12:00:00.000Z] client tasks [orch] pid=${process.pid}: subscribed as pane (3 tasks)\n`,
    )
  })

  describe("file write", () => {
    let home: string
    const prev = process.env.KOBE_HOME_DIR

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "kobe-clientlog-"))
      process.env.KOBE_HOME_DIR = home
    })

    afterEach(async () => {
      // biome-ignore lint/performance/noDelete: env must fully unset when it was unset pre-test (assigning undefined leaves the string "undefined").
      if (prev === undefined) delete process.env.KOBE_HOME_DIR
      else process.env.KOBE_HOME_DIR = prev
      await rm(home, { recursive: true, force: true })
    })

    it("appends to <home>/.kobe/client.log, creating the dir if absent", async () => {
      setClientLogContext("ops")
      logClient("reconnect", "daemon socket closed")
      logClient("reconnect", "reconnected after 2 attempts")
      await flushClientLog() // append is fire-and-forget async; wait for the chain
      const contents = await readFile(join(home, ".kobe", "client.log"), "utf8")
      const lines = contents.trim().split("\n")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("client ops [reconnect] ")
      expect(lines[0]).toContain("daemon socket closed")
      expect(lines[1]).toContain("reconnected after 2 attempts")
    })
  })
})
