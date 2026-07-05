/**
 * Unit tests for the composer prompt-history layers:
 *   - `history-store.ts` — JSONL disk persistence. Driven with explicit temp
 *     file paths (the functions all take a `path` arg), so no real ~/.kobe.
 *   - `history.ts` — the in-memory per-key ring + Ctrl+R palette snapshot,
 *     plus the disk bootstrap/persist branch (exercised via a temp
 *     `KOBE_HOME_DIR` so appendToDisk/loadFromDisk hit tmp, not real state).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  bootstrapHistory,
  clearAllHistory,
  getAllHistoryEntries,
  getHistory,
  pushHistory,
} from "../../src/tui/chat/composer/history"
import {
  type DiskHistoryEntry,
  appendToDisk,
  flushPendingWrites,
  loadFromDisk,
  pruneToCap,
} from "../../src/tui/chat/composer/history-store"

function tmp() {
  return mkdtempSync(join(tmpdir(), "kobe-hist-"))
}
const entry = (display: string, timestamp: number, extra: Partial<DiskHistoryEntry> = {}): DiskHistoryEntry => ({
  display,
  timestamp,
  project: undefined,
  taskId: undefined,
  ...extra,
})

describe("history-store disk layer", () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = tmp()
    path = join(dir, "composer-history.jsonl")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("loadFromDisk returns [] for a missing file", () => {
    expect(loadFromDisk(path)).toEqual([])
  })

  test("append then load round-trips and sorts by timestamp", async () => {
    await appendToDisk(entry("second", 200), path)
    await appendToDisk(entry("first", 100), path)
    await flushPendingWrites()
    expect(loadFromDisk(path).map((e) => e.display)).toEqual(["first", "second"])
  })

  test("loadFromDisk skips malformed / incomplete lines", () => {
    writeFileSync(
      path,
      [JSON.stringify(entry("good", 1)), "{ not json", JSON.stringify({ display: "no-timestamp" }), ""].join("\n"),
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(loadFromDisk(path).map((e) => e.display)).toEqual(["good"])
    warn.mockRestore()
  })

  test("pruneToCap trims the file to the newest `cap` lines, no-op under cap", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify(entry(`e${i}`, i))).join("\n")
    writeFileSync(path, `${lines}\n`)
    await pruneToCap(path, 10) // under cap → untouched
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(5)
    await pruneToCap(path, 2) // keep newest 2
    expect(loadFromDisk(path).map((e) => e.display)).toEqual(["e3", "e4"])
  })
})

describe("history in-memory ring (persistence off)", () => {
  beforeEach(() => {
    process.env.KOBE_HISTORY_PERSIST = "false"
    clearAllHistory()
  })

  test("pushHistory appends, dedups the immediate previous, ignores blanks", () => {
    pushHistory("tab", "one")
    pushHistory("tab", "one") // dup of last → ignored
    pushHistory("tab", "   ") // whitespace → ignored
    pushHistory("tab", "two")
    expect(getHistory("tab")).toEqual(["one", "two"])
  })

  test("getHistory is empty for an unknown key and isolated per key", () => {
    pushHistory("a", "x")
    expect(getHistory("b")).toEqual([])
    expect(getHistory("a")).toEqual(["x"])
  })

  test("getAllHistoryEntries merges keys newest-first by insertion seq", () => {
    pushHistory("a", "1st")
    pushHistory("b", "2nd")
    pushHistory("a", "3rd")
    expect(getAllHistoryEntries().map((e) => e.value)).toEqual(["3rd", "2nd", "1st"])
  })
})

describe("history disk bootstrap/persist branch", () => {
  let dir: string
  beforeEach(() => {
    dir = tmp()
    process.env.KOBE_HOME_DIR = dir
    process.env.KOBE_HISTORY_PERSIST = "true"
    clearAllHistory()
  })
  afterEach(() => {
    Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
    rmSync(dir, { recursive: true, force: true })
  })

  test("pushHistory persists and bootstrapHistory replays under the task key", async () => {
    pushHistory("task-7", "remembered", { project: "/repo", taskId: "task-7" })
    await flushPendingWrites()
    clearAllHistory()
    bootstrapHistory({ liveTaskIds: new Set(["task-7"]) })
    expect(getHistory("task-7")).toEqual(["remembered"])
  })

  test("an entry whose task is gone falls back to the project key", async () => {
    pushHistory("task-dead", "orphan", { project: "/repo", taskId: "task-dead" })
    await flushPendingWrites()
    clearAllHistory()
    bootstrapHistory({ liveTaskIds: new Set() }) // task-dead not alive
    expect(getHistory("task-dead")).toEqual([])
    expect(getAllHistoryEntries().some((e) => e.value === "orphan")).toBe(true)
  })
})
