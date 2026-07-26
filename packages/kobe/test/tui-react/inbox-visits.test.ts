import { describe, expect, test } from "vitest"
import {
  type InboxVisit,
  inboxVisitIndex,
  parseInboxVisits,
  readInboxVisits,
  recordInboxVisit,
  writeInboxVisit,
} from "../../src/tui-react/workspace/inbox-visits"

const visit = (taskId: string, tabId: string | null, at: number): InboxVisit => ({ taskId, tabId, at })

function fakeKv(seed: unknown = undefined) {
  const store = new Map<string, unknown>()
  if (seed !== undefined) store.set("inboxVisits", seed)
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

// RECENT answers "where was I", so the order comes from a visit log —
// `task.updatedAt` moves on any mutation and would answer "what changed".
describe("inbox visit log", () => {
  test("moves a revisited task to the front and adopts its new tab", () => {
    const log = recordInboxVisit([visit("a", "tab-1", 1), visit("b", "tab-9", 2)], visit("b", "tab-2", 3))
    expect(log).toEqual([visit("b", "tab-2", 3), visit("a", "tab-1", 1)])
  })

  test("keeps one entry per task and caps the log", () => {
    const log = [visit("a", null, 1), visit("b", null, 2), visit("c", null, 3)].reduce(
      (acc, entry) => recordInboxVisit(acc, entry, 2),
      [] as InboxVisit[],
    )
    expect(log.map((entry) => entry.taskId)).toEqual(["c", "b"])
  })

  test("skips the write when you never left the tab", () => {
    const kv = fakeKv()
    writeInboxVisit(kv, visit("a", "tab-1", 1))
    writeInboxVisit(kv, visit("a", "tab-1", 2))
    expect(kv.writes()).toBe(1)
    // The arrival time stands: `at` reads as "when you last came here".
    expect(readInboxVisits(kv)).toEqual([visit("a", "tab-1", 1)])

    writeInboxVisit(kv, visit("a", "tab-2", 3))
    expect(kv.writes()).toBe(2)
    expect(readInboxVisits(kv)).toEqual([visit("a", "tab-2", 3)])
  })

  test("drops malformed persisted entries instead of throwing", () => {
    expect(parseInboxVisits("nope")).toEqual([])
    expect(parseInboxVisits([{ taskId: "a" }, null, visit("b", null, 2)])).toEqual([visit("b", null, 2)])
    expect(readInboxVisits(fakeKv({ not: "an array" }))).toEqual([])
  })

  test("indexes by task, newest entry winning", () => {
    const index = inboxVisitIndex([visit("a", "tab-2", 5), visit("a", "tab-1", 1)])
    expect(index.get("a")).toEqual(visit("a", "tab-2", 5))
  })
})
