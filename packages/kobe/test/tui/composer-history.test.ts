import { beforeEach, describe, expect, test } from "vitest"
import {
  clearAllHistory,
  getAllHistoryEntries,
  getHistory,
  pushHistory,
} from "../../src/tui/panes/chat/composer/history.ts"

describe("composer/history — getAllHistoryEntries (KOB-154)", () => {
  beforeEach(() => {
    clearAllHistory()
  })

  test("returns entries from every key sorted globally newest-first by insertion seq", () => {
    pushHistory("task-a", "first from a")
    pushHistory("task-b", "first from b")
    pushHistory("task-a", "second from a")
    pushHistory("task-b", "second from b")

    const all = getAllHistoryEntries()

    // Newest first regardless of which key the entry came from.
    expect(all.map((e) => e.value)).toEqual([
      "second from b",
      "second from a",
      "first from b",
      "first from a",
    ])
    // Each row carries the key it came from so callers can resolve a label.
    expect(all[0]?.key).toBe("task-b")
    expect(all[3]?.key).toBe("task-a")
  })

  test("preserves the !-prefix for bash-mode submissions so callers can detect them", () => {
    pushHistory("task-a", "!ls -la")
    pushHistory("task-a", "regular prompt")
    const all = getAllHistoryEntries()
    expect(all[0]?.value).toBe("regular prompt")
    expect(all[1]?.value).toBe("!ls -la")
  })

  test("getHistory still returns plain string[] per key (no schema break for callers)", () => {
    pushHistory("k", "one")
    pushHistory("k", "two")
    const ring = getHistory("k")
    expect(ring).toEqual(["one", "two"])
  })

  test("empty store returns empty array", () => {
    expect(getAllHistoryEntries()).toEqual([])
  })
})
