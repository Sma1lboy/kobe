import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { flushPendingWrites } from "../../src/tui/panes/chat/composer/history-store.ts"
import {
  bootstrapHistory,
  clearAllHistory,
  getAllHistoryEntries,
  pushHistory,
} from "../../src/tui/panes/chat/composer/history.ts"

/**
 * End-to-end persistence test (KOB-157): proves that pushHistory()
 * actually lands on disk under a real KOBE_HOME_DIR and bootstrapHistory()
 * actually replays those entries into the in-memory STORE that
 * getAllHistoryEntries (the Ctrl+R palette feed) reads from. Without
 * this we only had layer-isolated tests — disk-store ops and in-memory
 * ops never met.
 *
 * The composer's pushHistory fires the disk write off-thread (`void
 * appendToDisk(...)`). The store now serializes appends through a
 * single Promise chain, so awaiting `flushPendingWrites()` gives a
 * deterministic settle point without polling. Without persistence
 * enabled this test would silently pass-by-default — we re-enable it
 * explicitly in beforeEach.
 */

const PRIOR_PERSIST = process.env.KOBE_HISTORY_PERSIST
const PRIOR_HOME = process.env.KOBE_HOME_DIR

async function readLines(path: string): Promise<string[]> {
  await flushPendingWrites()
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
}

describe("composer history persistence end-to-end (KOB-157)", () => {
  let homeDir: string
  let historyPath: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "kobe-history-e2e-"))
    process.env.KOBE_HOME_DIR = homeDir
    process.env.KOBE_HISTORY_PERSIST = "true"
    historyPath = join(homeDir, ".kobe", "composer-history.jsonl")
    clearAllHistory()
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    if (PRIOR_HOME === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
    else process.env.KOBE_HOME_DIR = PRIOR_HOME
    if (PRIOR_PERSIST === undefined) Reflect.deleteProperty(process.env, "KOBE_HISTORY_PERSIST")
    else process.env.KOBE_HISTORY_PERSIST = PRIOR_PERSIST
  })

  test("pushHistory writes to disk under KOBE_HOME_DIR", async () => {
    pushHistory("tab-abc", "first prompt", { project: "/repo/a" })
    pushHistory("tab-abc", "!ls -la", { project: "/repo/a" })

    const lines = await readLines(historyPath)
    expect(lines).toHaveLength(2)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].display).toBe("first prompt")
    expect(parsed[0].project).toBe("/repo/a")
    expect(parsed[0].timestamp).toBeTypeOf("number")
    // Bash prefix survives verbatim — reload restores the KOB-151 recall path.
    expect(parsed[1].display).toBe("!ls -la")
  })

  test("bootstrapHistory replays disk entries into the Ctrl+R palette feed", async () => {
    pushHistory("tab-abc", "alpha", { project: "/repo/a" })
    pushHistory("tab-def", "beta", { project: "/repo/b" })
    pushHistory("tab-def", "!grep foo", { project: "/repo/b" })

    const lines3 = await readLines(historyPath)
    expect(lines3).toHaveLength(3)

    // Simulate a fresh kobe boot: drop the in-memory STORE, then
    // bootstrapHistory should rehydrate from disk.
    clearAllHistory()
    expect(getAllHistoryEntries()).toEqual([])

    bootstrapHistory()

    const all = getAllHistoryEntries()
    expect(all.map((e) => e.value)).toEqual(["!grep foo", "beta", "alpha"])
    // Replayed entries land under a synthetic per-project key so a
    // future palette filter can scope by current task's repo root.
    expect(all[0]?.key).toBe("project-/repo/b")
    expect(all[2]?.key).toBe("project-/repo/a")
  })

  test("persists across process-like boundaries: load → boot → push → load again", async () => {
    pushHistory("tab-1", "from session one", { project: "/repo/p" })
    const lines1 = await readLines(historyPath)
    expect(lines1).toHaveLength(1)

    // "Restart": clear memory, boot from disk.
    clearAllHistory()
    bootstrapHistory()

    // The boot replay made the entry visible to the palette.
    expect(getAllHistoryEntries().map((e) => e.value)).toEqual(["from session one"])

    // A fresh push in the "new session" appends; the on-disk file now
    // has both entries.
    pushHistory("tab-2", "from session two", { project: "/repo/p" })
    const lines = await readLines(historyPath)
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => JSON.parse(l).display)).toEqual(["from session one", "from session two"])
  })

  test("persists nothing when KOBE_HISTORY_PERSIST=false", async () => {
    process.env.KOBE_HISTORY_PERSIST = "false"
    pushHistory("tab-abc", "should not be written", { project: "/repo/a" })
    await flushPendingWrites()
    expect(existsSync(historyPath)).toBe(false)
  })
})
