import { describe, expect, test } from "vitest"
import {
  COMPLETION_SEEN_KEY,
  completionSeenAt,
  completionSeenKey,
  foldCompletionSeen,
  markCompletionSeen,
  parseCompletionSeen,
} from "../../src/tui-react/workspace/completion-seen"

function fakeKv(seed?: unknown) {
  const store = new Map<string, unknown>()
  if (seed !== undefined) store.set(COMPLETION_SEEN_KEY, seed)
  let writes = 0
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      writes++
      store.set(key, value)
    },
    writes: () => writes,
  }
}

// Issue #22 (owner report 2026-08-12): the sidebar's unread lamp only knew
// what THIS process had seen, so relaunching kobe re-lit every completion
// the daemon still reported. The durable mark is what crosses the restart.
describe("durable completion-seen marks", () => {
  test("a mark covers its own completion and every older one", () => {
    const kv = fakeKv()
    const key = completionSeenKey("task-a", "tab-1")
    markCompletionSeen(kv, key, 1_000)
    expect(completionSeenAt(kv, key, 1_000)).toBe(true)
    expect(completionSeenAt(kv, key, 900)).toBe(true)
    // The next turn completes: a NEWER stamp is unread again.
    expect(completionSeenAt(kv, key, 1_001)).toBe(false)
  })

  test("a row that is not sitting on a completion is never seen", () => {
    const kv = fakeKv({ "task-a": 1_000 })
    expect(completionSeenAt(kv, "task-a", undefined)).toBe(false)
    // No KV provider at all (render tests, panes outside the context).
    expect(completionSeenAt(null, "task-a", 1_000)).toBe(false)
  })

  test("tabs of one task keep independent marks", () => {
    const kv = fakeKv()
    markCompletionSeen(kv, completionSeenKey("task-a", "tab-1"), 5)
    expect(completionSeenAt(kv, completionSeenKey("task-a", "tab-1"), 5)).toBe(true)
    expect(completionSeenAt(kv, completionSeenKey("task-a", "tab-2"), 5)).toBe(false)
    // The task-level key (the flat sidebar's cards) is its own row too.
    expect(completionSeenAt(kv, completionSeenKey("task-a"), 5)).toBe(false)
  })

  test("re-marking an already-covered completion writes nothing", () => {
    const kv = fakeKv()
    const key = completionSeenKey("task-a", "tab-1")
    markCompletionSeen(kv, key, 10)
    markCompletionSeen(kv, key, 10)
    markCompletionSeen(kv, key, 9)
    expect(kv.writes()).toBe(1)
  })

  test("malformed persisted state degrades to nothing seen", () => {
    expect(parseCompletionSeen(["nope"])).toEqual({})
    expect(parseCompletionSeen(null)).toEqual({})
    expect(parseCompletionSeen({ good: 1, bad: "later", worse: Number.NaN })).toEqual({ good: 1 })
    const kv = fakeKv("not-an-object")
    expect(completionSeenAt(kv, "task-a", 1)).toBe(false)
  })

  test("prunes the oldest marks at the cap", () => {
    const seed: Record<string, number> = {}
    for (let i = 0; i < 5; i++) seed[`task-${i}`] = i
    const next = foldCompletionSeen(seed, "task-new", 99, 3)
    expect(Object.keys(next).sort()).toEqual(["task-3", "task-4", "task-new"])
  })
})
