/**
 * Tab reorder within a task (sidebar move mode, issue #43): the pure
 * `moveTab` core (edge-stop, no wrap) and the mounted-vs-background fork in
 * `moveTaskTab` — order must land in the module map AND the kv snapshot so
 * it survives restart (`rehydrateTabs` keeps array order).
 */

import { afterEach, describe, expect, it } from "vitest"
import { moveTaskTab } from "../../src/tui-react/workspace/terminal-tabs-move.ts"
import type { TabsSnapshotKv } from "../../src/tui-react/workspace/terminal-tabs-persist.ts"
import { tabActivationListeners, tabsByTask, takeTabMove } from "../../src/tui-react/workspace/terminal-tabs-shared.ts"
import { type TabsState, moveTab, rehydrateTabs } from "../../src/tui/workspace/terminal-tabs-core.ts"

function state(ids: readonly string[]): TabsState {
  return {
    tabs: ids.map((id, i) => ({ kind: "engine" as const, id, title: null, ordinal: i + 1 })),
    activeId: ids[0] as string,
    nextOrdinal: ids.length + 1,
  }
}

const order = (s: TabsState): string[] => s.tabs.map((t) => t.id)

describe("moveTab (core)", () => {
  it("swaps a tab with its neighbour in either direction", () => {
    const s = state(["tab-1", "tab-2", "tab-3"])
    expect(order(moveTab(s, "tab-2", 1))).toEqual(["tab-1", "tab-3", "tab-2"])
    expect(order(moveTab(s, "tab-2", -1))).toEqual(["tab-2", "tab-1", "tab-3"])
    // activeId is position-independent — a move never changes it.
    expect(moveTab(s, "tab-2", 1).activeId).toBe("tab-1")
  })

  it("edge-stops: first up / last down return the SAME state, no wrap", () => {
    const s = state(["tab-1", "tab-2"])
    expect(moveTab(s, "tab-1", -1)).toBe(s)
    expect(moveTab(s, "tab-2", 1)).toBe(s)
  })

  it("no-ops on an unknown tab id", () => {
    const s = state(["tab-1"])
    expect(moveTab(s, "tab-9", 1)).toBe(s)
  })

  it("survives the persistence round-trip — rehydrate keeps the moved order", () => {
    const moved = moveTab(state(["tab-1", "tab-2", "tab-3"]), "tab-3", -1)
    expect(order(rehydrateTabs(moved, ["zsh"]))).toEqual(["tab-1", "tab-3", "tab-2"])
  })
})

describe("moveTaskTab (background write)", () => {
  afterEach(() => tabsByTask.clear())

  function kvStub(): TabsSnapshotKv & { writes: Array<[string, unknown]> } {
    const writes: Array<[string, unknown]> = []
    return {
      store: {},
      writes,
      set(key, value) {
        writes.push([key, value])
      },
    }
  }

  it("writes the module map and kv snapshot when no component owns the task", () => {
    const kv = kvStub()
    tabsByTask.set("t1", state(["tab-1", "tab-2"]))
    expect(moveTaskTab(kv, "t1", "tab-2", -1)).toBe(true)
    expect(order(tabsByTask.get("t1") as TabsState)).toEqual(["tab-2", "tab-1"])
    expect(kv.writes.map(([key]) => key)).toEqual(["terminalTabs.t1"])
  })

  it("reads the kv snapshot for a task not in the module map", () => {
    const kv = kvStub()
    kv.store["terminalTabs.t2"] = state(["tab-1", "tab-2", "tab-3"])
    expect(moveTaskTab(kv, "t2", "tab-1", 1)).toBe(true)
    expect(order(tabsByTask.get("t2") as TabsState)).toEqual(["tab-2", "tab-1", "tab-3"])
  })

  it("edge-stop writes NOTHING — top/bottom is a silent no-op", () => {
    const kv = kvStub()
    const s = state(["tab-1", "tab-2"])
    tabsByTask.set("t1", s)
    expect(moveTaskTab(kv, "t1", "tab-1", -1)).toBe(false)
    expect(tabsByTask.get("t1")).toBe(s)
    expect(kv.writes).toEqual([])
  })

  it("returns false for a task that never opened tabs", () => {
    expect(moveTaskTab(kvStub(), "ghost", "tab-1", 1)).toBe(false)
  })

  it("a mounted claimant owns the write — background touches nothing", () => {
    // Same claim protocol as closeTaskTab: a listener that consumes the
    // request stands in for the mounted TerminalTabs, and moveTaskTab must
    // then leave the module map + kv alone.
    const kv = kvStub()
    const s = state(["tab-1", "tab-2"])
    tabsByTask.set("t1", s)
    const claims: Array<{ tabId: string; delta: -1 | 1 }> = []
    const claimant = (): void => {
      const move = takeTabMove("t1")
      if (move) claims.push(move)
    }
    tabActivationListeners.add(claimant)
    try {
      expect(moveTaskTab(kv, "t1", "tab-2", -1)).toBe(true)
    } finally {
      tabActivationListeners.delete(claimant)
    }
    expect(claims).toEqual([{ tabId: "tab-2", delta: -1 }])
    expect(tabsByTask.get("t1")).toBe(s)
    expect(kv.writes).toEqual([])
  })
})
