/**
 * Fold execution (issue #40): the scratch shell's hosted sessions move
 * under the owning task's next free tab ids and get adopted into its tab
 * state — quietly (adoption never steals the target's active tab), and
 * only when the host actually re-keyed something (an old host or a dead
 * session must NOT delete the scratch row over nothing).
 */

import { afterEach, describe, expect, it } from "vitest"
import { foldScratchShell } from "../../src/tui-react/workspace/scratch-fold"
import type { TabsSnapshotKv } from "../../src/tui-react/workspace/terminal-tabs-persist"
import { tabsByTask } from "../../src/tui-react/workspace/terminal-tabs-shared"
import { scratchOwnerTasks } from "../../src/tui-react/workspace/use-scratch-adopt"
import type { Task } from "../../src/types/task"

const SCRATCH = "01SCRATCHFOLD"
const TARGET = "01TARGETFOLD"

function fakeKv(seed: Record<string, unknown> = {}): TabsSnapshotKv {
  const store: Record<string, unknown> = { ...seed }
  return {
    store,
    set(key: string, value: unknown) {
      store[key] = value
    },
  } as TabsSnapshotKv
}

afterEach(() => {
  tabsByTask.delete(SCRATCH)
  tabsByTask.delete(TARGET)
})

describe("foldScratchShell", () => {
  it("renames the shell under the target's next free tab id and adopts it", async () => {
    const kv = fakeKv({
      [`terminalTabs.${TARGET}`]: {
        tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1 }],
        activeId: "tab-1",
        nextOrdinal: 2,
      },
    })
    const renames: [string, string][] = []
    const folded = await foldScratchShell(
      {
        kv,
        rename: async (from, to) => {
          renames.push([from, to])
          return true
        },
      },
      SCRATCH,
      TARGET,
    )
    expect(renames).toEqual([[`${SCRATCH}::tab-1`, `${TARGET}::tab-2`]])
    expect(folded).toEqual({ activeTabId: "tab-2" })
    const state = kv.store[`terminalTabs.${TARGET}`] as { tabs: { id: string }[]; activeId: string }
    expect(state.tabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-2"])
    // Quiet fold: the target's active tab is untouched.
    expect(state.activeId).toBe("tab-1")
  })

  it("bumps once past an occupied target key, then gives up on that tab", async () => {
    const kv = fakeKv()
    const taken = new Set([`${TARGET}::tab-1`])
    const folded = await foldScratchShell({ kv, rename: async (_from, to) => !taken.has(to) }, SCRATCH, TARGET)
    expect(folded).toEqual({ activeTabId: "tab-2" })
  })

  it("answers null when the host moved nothing — the scratch row must stay", async () => {
    const kv = fakeKv()
    const folded = await foldScratchShell({ kv, rename: async () => false }, SCRATCH, TARGET)
    expect(folded).toBeNull()
    expect(kv.store[`terminalTabs.${TARGET}`]).toBeUndefined()
  })

  it("moves every scratch tab, not just the shell", async () => {
    const kv = fakeKv({
      [`terminalTabs.${SCRATCH}`]: {
        tabs: [
          { kind: "command", id: "tab-1", ordinal: 1 },
          { kind: "engine", id: "tab-2", ordinal: 2 },
        ],
        activeId: "tab-1",
        nextOrdinal: 3,
      },
    })
    const renames: [string, string][] = []
    const folded = await foldScratchShell(
      {
        kv,
        rename: async (from, to) => {
          renames.push([from, to])
          return true
        },
      },
      SCRATCH,
      TARGET,
    )
    expect(renames.map(([from]) => from)).toEqual([`${SCRATCH}::tab-1`, `${SCRATCH}::tab-2`])
    // The folded shell (the tab the user was watching) is the follow target.
    expect(folded).toEqual({ activeTabId: "tab-1" })
    const state = kv.store[`terminalTabs.${TARGET}`] as { tabs: { id: string }[] }
    expect(state.tabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-2"])
  })
})

describe("scratchOwnerTasks", () => {
  it("keeps main/dir/managed rows, drops scratch/archived/pathless ones", () => {
    const base = { repo: "/r", branch: "", status: "backlog", archived: false } as unknown as Task
    const tasks = [
      { ...base, id: "a", kind: "main", worktreePath: "/r" },
      { ...base, id: "b", kind: "task", worktreePath: "/w/b" },
      { ...base, id: "c", kind: "dir", scratch: true, worktreePath: "/home" },
      { ...base, id: "d", kind: "dir", worktreePath: "/r/sub", archived: true },
      { ...base, id: "e", kind: "task", worktreePath: "" },
    ] as unknown as Task[]
    expect(scratchOwnerTasks(tasks).map((t) => t.id)).toEqual(["a", "b"])
  })
})
