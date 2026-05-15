import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  DISK_HISTORY_CAP,
  type DiskHistoryEntry,
  appendToDisk,
  loadFromDisk,
  pruneToCap,
} from "../../src/tui/panes/chat/composer/history-store.ts"

describe("composer/history-store (KOB-157)", () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-history-store-"))
    path = join(dir, "composer-history.jsonl")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("missing file loads as empty", () => {
    expect(loadFromDisk(path)).toEqual([])
  })

  test("append + load round-trips and preserves order (oldest → newest)", async () => {
    const a: DiskHistoryEntry = { display: "first", timestamp: 1, project: "/repo/a" }
    const b: DiskHistoryEntry = { display: "second", timestamp: 2, project: "/repo/b" }
    const c: DiskHistoryEntry = { display: "!ls -la", timestamp: 3, project: undefined }
    await appendToDisk(a, path)
    await appendToDisk(b, path)
    await appendToDisk(c, path)

    const loaded = loadFromDisk(path)
    expect(loaded).toEqual([a, b, c])
    // Bash prefix preserved verbatim so reload restores the recall path.
    expect(loaded[2]?.display.startsWith("!")).toBe(true)
  })

  test("malformed lines are skipped, valid lines survive", () => {
    // Hand-craft a file with garbage interleaved.
    writeFileSync(
      path,
      [
        JSON.stringify({ display: "ok one", timestamp: 1, project: "/r" }),
        "this is not json",
        JSON.stringify({ display: "ok two", timestamp: 2, project: "/r" }),
        JSON.stringify({ display: 42, timestamp: 3 }), // wrong type for display
        "",
        JSON.stringify({ display: "ok three", timestamp: 4 }),
      ].join("\n"),
    )
    const loaded = loadFromDisk(path)
    expect(loaded.map((e) => e.display)).toEqual(["ok one", "ok two", "ok three"])
  })

  test("pruneToCap rewrites the file to the newest N entries", async () => {
    // Write CAP + 5 entries so prune has work to do.
    for (let i = 0; i < DISK_HISTORY_CAP + 5; i++) {
      await appendToDisk({ display: `entry ${i}`, timestamp: i, project: "/r" }, path)
    }
    await pruneToCap(path, DISK_HISTORY_CAP)
    const remaining = loadFromDisk(path)
    expect(remaining.length).toBe(DISK_HISTORY_CAP)
    // Newest survives; oldest is dropped.
    expect(remaining[0]?.display).toBe("entry 5")
    expect(remaining[remaining.length - 1]?.display).toBe(`entry ${DISK_HISTORY_CAP + 4}`)
  })

  test("pruneToCap is a no-op below the cap", async () => {
    await appendToDisk({ display: "a", timestamp: 1, project: undefined }, path)
    await appendToDisk({ display: "b", timestamp: 2, project: undefined }, path)
    const before = readFileSync(path, "utf8")
    await pruneToCap(path, DISK_HISTORY_CAP)
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  test("appendToDisk creates the parent dir on a fresh install", async () => {
    const nested = join(dir, "nested", "deeper", "composer-history.jsonl")
    await appendToDisk({ display: "fresh", timestamp: 1, project: undefined }, nested)
    expect(loadFromDisk(nested)).toEqual([{ display: "fresh", timestamp: 1, project: undefined }])
  })
})
