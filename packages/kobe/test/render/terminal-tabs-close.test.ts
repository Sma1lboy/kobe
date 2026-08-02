/**
 * `closeTaskTab`'s mounted-vs-background fork.
 *
 * Lives in the bun-run render track (not vitest) because the module reaches
 * the PTY registry and the split helper, which pull in opentui.
 *
 * The fork is the whole point of the module: if BOTH paths ran, a mounted
 * TerminalTabs would write its React state and then have the background write
 * clobber it from underneath; if NEITHER ran, closing a non-selected
 * worktree's tab would silently do nothing.
 */

import { expect, test } from "bun:test"
import { closeTaskTab } from "../../src/tui-react/workspace/terminal-tabs-close"
import { terminalTabsKey } from "../../src/tui-react/workspace/terminal-tabs-persist"
import { tabActivationListeners, tabsByTask, takeTabClose } from "../../src/tui-react/workspace/terminal-tabs-shared"
import type { TabsState } from "../../src/tui/workspace/terminal-tabs-core"

function state(ids: readonly string[], activeId = ids[0] ?? "tab-1"): TabsState {
  return {
    tabs: ids.map((id, i) => ({ kind: "engine" as const, id, title: null, ordinal: i + 1, vendor: "claude" as const })),
    activeId,
    nextOrdinal: ids.length + 1,
  }
}

/** Minimal stand-in for the KV context the host passes in. */
function fakeKv() {
  const store: Record<string, unknown> = {}
  return {
    store,
    set(key: string, value: unknown) {
      store[key] = value
    },
    writes: store,
  }
}

test("no mounted owner: the background path writes the map and the snapshot", () => {
  tabsByTask.clear()
  tabsByTask.set("t1", state(["tab-1", "tab-2"]))
  const kv = fakeKv()

  expect(closeTaskTab(kv, "t1", "tab-2")).toBe(true)

  expect(tabsByTask.get("t1")?.tabs.map((tab) => tab.id)).toEqual(["tab-1"])
  // The snapshot must move too, or a restart resurrects the closed tab.
  expect((kv.store[terminalTabsKey("t1")] as TabsState).tabs.map((tab) => tab.id)).toEqual(["tab-1"])
})

test("closing the ACTIVE tab moves activeId to a surviving one", () => {
  tabsByTask.clear()
  tabsByTask.set("t1", state(["tab-1", "tab-2"], "tab-2"))
  expect(closeTaskTab(fakeKv(), "t1", "tab-2")).toBe(true)
  expect(tabsByTask.get("t1")?.activeId).toBe("tab-1")
})

test("a mounted owner claims the request, and the background write does NOT also run", () => {
  tabsByTask.clear()
  const before = state(["tab-1", "tab-2"])
  tabsByTask.set("t1", before)
  const claimed: string[] = []
  const listener = () => {
    const id = takeTabClose("t1")
    if (id) claimed.push(id)
  }
  tabActivationListeners.add(listener)
  try {
    expect(closeTaskTab(fakeKv(), "t1", "tab-2")).toBe(true)
  } finally {
    tabActivationListeners.delete(listener)
  }

  expect(claimed).toEqual(["tab-2"])
  // Untouched: the mounted component owns the write. A background write here
  // would race the component's own setState.
  expect(tabsByTask.get("t1")).toBe(before)
})

test("a listener for a DIFFERENT task does not claim it", () => {
  tabsByTask.clear()
  tabsByTask.set("t1", state(["tab-1", "tab-2"]))
  const listener = () => void takeTabClose("other-task")
  tabActivationListeners.add(listener)
  try {
    expect(closeTaskTab(fakeKv(), "t1", "tab-2")).toBe(true)
  } finally {
    tabActivationListeners.delete(listener)
  }
  expect(tabsByTask.get("t1")?.tabs.map((tab) => tab.id)).toEqual(["tab-1"])
})

test("the last tab is refused, and an unknown task reports failure", () => {
  tabsByTask.clear()
  tabsByTask.set("t1", state(["tab-1"]))
  expect(closeTaskTab(fakeKv(), "t1", "tab-1")).toBe(false)
  expect(tabsByTask.get("t1")?.tabs).toHaveLength(1)
  expect(closeTaskTab(fakeKv(), "never-mounted", "tab-1")).toBe(false)
})

test("a task with only a restart snapshot still closes", () => {
  // The tree lists tabs for worktrees that have not mounted since restart —
  // those live in kv, not the module map.
  tabsByTask.clear()
  const kv = fakeKv()
  kv.store[terminalTabsKey("t9")] = state(["tab-1", "tab-2"])
  expect(closeTaskTab(kv, "t9", "tab-1")).toBe(true)
  expect((kv.store[terminalTabsKey("t9")] as TabsState).tabs.map((tab) => tab.id)).toEqual(["tab-2"])
})
