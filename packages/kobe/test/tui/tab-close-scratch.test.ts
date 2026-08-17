/**
 * ctrl+w on a task's ONLY tab (issue #42): a scratch task tears down the
 * whole task (same zero-ceremony path as its shell exiting — `onScratchExit`),
 * while an ordinary task keeps the "cannot close the only tab" refusal.
 */

import { describe, expect, it, vi } from "vitest"

// The close hook's PTY-release imports pull in @opentui/react (TerminalSplit)
// and the live registry — neither loads under vitest's node environment, and
// neither is what this suite locks. The policy branch is.
vi.mock("../../src/tui-react/workspace/TerminalSplit.tsx", () => ({ releaseSplitLeaves: () => {} }))
vi.mock("../../src/tui-react/workspace/terminal-tabs-close.ts", () => ({ releaseClosedTabPtys: () => {} }))
vi.mock("../../src/tui/panes/terminal/registry.ts", () => ({
  getDefaultPtyRegistry: () => ({ release: () => {} }),
}))

import { useTabClose } from "../../src/tui-react/workspace/use-tab-close.ts"
import { type TabsState, type TerminalTab, initialShellTabs } from "../../src/tui/workspace/terminal-tabs-core.ts"

function harness(state: TabsState, opts: { scratch?: boolean } = {}) {
  const calls = { scratchExit: 0, cannotCloseLast: 0, updates: [] as TabsState[] }
  const active = state.tabs.find((tab) => tab.id === state.activeId) as TerminalTab
  const close = useTabClose({
    stateRef: { current: state },
    propsRef: { current: { taskId: "t1" } },
    updateRef: { current: (next) => calls.updates.push(next) },
    active,
    pinSession: (s) => s,
    bumpResetToken: () => {},
    resumeTriedRef: { current: new Set() },
    notifyCannotCloseLast: () => {
      calls.cannotCloseLast += 1
    },
    ...(opts.scratch
      ? {
          onScratchExit: () => {
            calls.scratchExit += 1
          },
        }
      : {}),
  })
  return { close, calls }
}

describe("closeActive on the only tab", () => {
  it("scratch task: tears the task down instead of refusing", () => {
    const { close, calls } = harness(initialShellTabs("/bin/zsh"), { scratch: true })
    close.closeActive()
    expect(calls.scratchExit).toBe(1)
    expect(calls.cannotCloseLast).toBe(0)
    expect(calls.updates).toHaveLength(0)
  })

  it("ordinary task: still refuses with the toast", () => {
    const { close, calls } = harness(initialShellTabs("/bin/zsh"))
    close.closeActive()
    expect(calls.cannotCloseLast).toBe(1)
    expect(calls.updates).toHaveLength(0)
  })
})
