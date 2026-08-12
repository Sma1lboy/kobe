/**
 * Adoption routes through the same claim protocol as tab-close: a mounted
 * `TerminalTabs` owns its task's state, so the background writer must stay
 * out of its way. Both halves writing would clobber the component's React
 * state with a snapshot it never agreed to.
 */

import { afterEach, describe, expect, it } from "vitest"
import { adoptTaskTabs } from "../../src/tui-react/workspace/terminal-tabs-adopt"
import type { TabsSnapshotKv } from "../../src/tui-react/workspace/terminal-tabs-persist"
import { tabActivationListeners, tabsByTask, takeTabAdopt } from "../../src/tui-react/workspace/terminal-tabs-shared"

const TASK = "01TESTADOPTCLAIM"

function fakeKv(): TabsSnapshotKv {
  const store: Record<string, unknown> = {}
  return {
    store,
    set(key: string, value: unknown) {
      store[key] = value
    },
  } as TabsSnapshotKv
}

afterEach(() => {
  tabActivationListeners.clear()
  tabsByTask.delete(TASK)
})

describe("adoptTaskTabs", () => {
  it("writes the snapshot when no mounted component claims the task", () => {
    const kv = fakeKv()
    expect(adoptTaskTabs(kv, TASK, ["tab-4"])).toBe(true)
    const written = kv.store[`terminalTabs.${TASK}`] as { tabs: { id: string }[] }
    expect(written.tabs.map((tab) => tab.id)).toEqual(["tab-4"])
  })

  it("leaves the write to the mounted component when one claims it", () => {
    const kv = fakeKv()
    const claimed: string[][] = []
    tabActivationListeners.add(() => {
      const ids = takeTabAdopt(TASK)
      if (ids) claimed.push([...ids])
    })
    expect(adoptTaskTabs(kv, TASK, ["tab-4"])).toBe(false)
    expect(claimed).toEqual([["tab-4"]])
    expect(kv.store).toEqual({})
  })

  it("does not write when the tabs are already known — it runs off a poll", () => {
    const kv = fakeKv()
    adoptTaskTabs(kv, TASK, ["tab-4"])
    const first = kv.store[`terminalTabs.${TASK}`]
    expect(adoptTaskTabs(kv, TASK, ["tab-4"])).toBe(false)
    expect(kv.store[`terminalTabs.${TASK}`]).toBe(first)
  })
})
