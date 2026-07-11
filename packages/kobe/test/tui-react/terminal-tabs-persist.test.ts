/**
 * Locks the O19 reclamation contract: a DELETED task's `terminalTabs.*`
 * snapshot is dropped, an ARCHIVED task's is kept (unarchive --resume needs
 * it), and the one-time orphan sweep drops only keys whose task id is absent
 * from the live set — with archived task ids in that set so their snapshots
 * survive. Uses a fake kv mirroring kv-core's explicit-undefined delete.
 */

import { describe, expect, it } from "vitest"
import {
  type TabsSnapshotKv,
  forgetTaskTabsSnapshot,
  sweepOrphanTabsSnapshots,
  terminalTabsKey,
} from "../../src/tui-react/workspace/terminal-tabs-persist"

/** Fake kv: `set(k, undefined)` deletes the key, matching kv-core. */
function fakeKv(initial: Record<string, unknown> = {}): TabsSnapshotKv {
  const store: Record<string, unknown> = { ...initial }
  return {
    store,
    set(key, value) {
      if (value === undefined) delete store[key]
      else store[key] = value
    },
  }
}

describe("forgetTaskTabsSnapshot", () => {
  it("deletes the deleted task's snapshot and leaves others alone", () => {
    const kv = fakeKv({
      [terminalTabsKey("a")]: { tabs: [] },
      [terminalTabsKey("b")]: { tabs: [] },
      "unrelated.key": 1,
    })
    forgetTaskTabsSnapshot(kv, "a")
    expect(kv.store[terminalTabsKey("a")]).toBeUndefined()
    expect(kv.store[terminalTabsKey("b")]).toEqual({ tabs: [] })
    expect(kv.store["unrelated.key"]).toBe(1)
  })

  it("is a no-op when the task has no snapshot", () => {
    const kv = fakeKv({ "unrelated.key": 1 })
    forgetTaskTabsSnapshot(kv, "ghost")
    expect(kv.store).toEqual({ "unrelated.key": 1 })
  })
})

describe("sweepOrphanTabsSnapshots", () => {
  it("drops orphans, keeps live AND archived tasks, ignores non-prefix keys", () => {
    const kv = fakeKv({
      [terminalTabsKey("live")]: { tabs: [] },
      [terminalTabsKey("archived")]: { tabs: [] },
      [terminalTabsKey("orphan1")]: { tabs: [] },
      [terminalTabsKey("orphan2")]: { tabs: [] },
      "activeSortMode": "recent",
    })
    // liveTaskIds MUST include archived tasks — their snapshots are kept.
    const swept = sweepOrphanTabsSnapshots(kv, ["live", "archived"])
    expect(swept).toBe(2)
    expect(kv.store[terminalTabsKey("live")]).toEqual({ tabs: [] })
    expect(kv.store[terminalTabsKey("archived")]).toEqual({ tabs: [] })
    expect(kv.store[terminalTabsKey("orphan1")]).toBeUndefined()
    expect(kv.store[terminalTabsKey("orphan2")]).toBeUndefined()
    expect(kv.store["activeSortMode"]).toBe("recent")
  })

  it("is idempotent — a second sweep removes nothing more", () => {
    const kv = fakeKv({ [terminalTabsKey("orphan")]: { tabs: [] } })
    expect(sweepOrphanTabsSnapshots(kv, [])).toBe(1)
    expect(sweepOrphanTabsSnapshots(kv, [])).toBe(0)
  })
})
