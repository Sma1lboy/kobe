/**
 * `useTabNaming` — the per-tab first-prompt naming pass.
 *
 * Two ways a tab finds its name, and the second is why this file exists:
 * only claude accepts `--session-id`, so kobe pins a session id on claude
 * tabs and on nothing else. Codex/copilot/kimi tabs therefore had NO id to
 * look a transcript up by, were skipped entirely, and fell all the way to
 * the numbered vendor default ("codex 1") — which, once codex's thread-id
 * OSC title stopped naming them (owner report 2026-08-17), was all they had
 * left. Their history readers still resolve a worktree's sessions by the cwd
 * recorded in the transcript, which is the fallback asserted below.
 *
 * The hook is mount-only (`useEffect` with an empty dep list) and drives a
 * plain `setInterval`, so React is mocked down to "run the effect now" and
 * the pass is driven with fake timers — no renderer needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fromSessionId: vi.fn(),
  fromWorktree: vi.fn(),
}))

vi.mock("@/monitor/auto-title", () => ({
  deriveTitleFromSessionId: mocks.fromSessionId,
  deriveTitleFromSession: mocks.fromWorktree,
}))

const cleanups: Array<() => void> = []
vi.mock("react", () => ({
  useEffect: (fn: () => (() => void) | undefined) => {
    const cleanup = fn()
    if (cleanup) cleanups.push(cleanup)
  },
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
}))

import { useTabNaming } from "../../src/tui-react/workspace/use-tab-lifecycle.ts"
import { type TabsState, type TerminalTab, initialTabs } from "../../src/tui/workspace/terminal-tabs-core.ts"
import type { VendorId } from "../../src/types/vendor.ts"

const engineTab = (over: Partial<TerminalTab>): TerminalTab =>
  ({ kind: "engine", id: "tab-1", title: null, ordinal: 1, ...over }) as TerminalTab

/** A mutable stand-in for the caller's latest-render refs. */
function harness(tabs: TerminalTab[], vendor: VendorId, worktree = "/wt") {
  const state: TabsState = { ...initialTabs(), tabs, activeId: tabs[0]?.id ?? "tab-1" }
  const io = {
    stateRef: { current: state },
    propsRef: { current: { vendor, worktree } },
    update: (next: TabsState) => {
      io.stateRef.current = next
    },
  }
  return io
}

/** Run exactly one naming tick and let its async body settle. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000)
}

beforeEach(() => {
  cleanups.length = 0
  mocks.fromSessionId.mockReset()
  mocks.fromWorktree.mockReset()
  mocks.fromSessionId.mockResolvedValue("")
  mocks.fromWorktree.mockResolvedValue("")
  vi.useFakeTimers()
})

describe("useTabNaming", () => {
  it("names a session-pinned tab by its id, and marks it spawned", async () => {
    mocks.fromSessionId.mockResolvedValue("wire up the digest verb")
    const io = harness([engineTab({ vendor: "claude", sessionId: "sess-1" })], "claude")
    useTabNaming(io)
    await tick()
    expect(mocks.fromSessionId).toHaveBeenCalledWith("claude", "sess-1")
    expect(mocks.fromWorktree).not.toHaveBeenCalled()
    const tab = io.stateRef.current.tabs[0] as TerminalTab
    expect(tab.autoTitle).toBe("wire up the digest verb")
    expect((tab as { spawned?: boolean }).spawned).toBe(true)
  })

  it("names an UNPINNED tab from the worktree's origin conversation", async () => {
    mocks.fromWorktree.mockResolvedValue("add the ruler")
    const io = harness([engineTab({ vendor: "codex" })], "codex", "/wt/warthog")
    useTabNaming(io)
    await tick()
    expect(mocks.fromWorktree).toHaveBeenCalledWith("/wt/warthog", "codex")
    const tab = io.stateRef.current.tabs[0] as TerminalTab
    expect(tab.autoTitle).toBe("add the ruler")
    // A transcript in the worktree says nothing about THIS tab's process.
    expect((tab as { spawned?: boolean }).spawned).toBeUndefined()
  })

  // The worktree's ORIGIN conversation belongs to the first engine tab by
  // construction; a later tab's session can't be told apart from one the user
  // started by hand in the same directory, and a plausible-but-wrong name is
  // worse than the numbered default.
  it("only the FIRST engine tab takes the worktree fallback", async () => {
    mocks.fromWorktree.mockResolvedValue("add the ruler")
    const io = harness(
      [engineTab({ vendor: "codex" }), engineTab({ id: "tab-2", ordinal: 2, vendor: "codex" })],
      "codex",
    )
    useTabNaming(io)
    await tick()
    expect(mocks.fromWorktree).toHaveBeenCalledTimes(1)
    expect((io.stateRef.current.tabs[1] as TerminalTab).autoTitle).toBeUndefined()
  })

  it("stops asking once a tab has a name — no per-tick rescan", async () => {
    mocks.fromWorktree.mockResolvedValue("add the ruler")
    const io = harness([engineTab({ vendor: "codex" })], "codex")
    useTabNaming(io)
    await tick()
    await tick()
    expect(mocks.fromWorktree).toHaveBeenCalledTimes(1)
  })

  it("leaves a manual rename alone", async () => {
    const io = harness([engineTab({ vendor: "codex", title: "my tab" })], "codex")
    useTabNaming(io)
    await tick()
    expect(mocks.fromWorktree).not.toHaveBeenCalled()
  })

  it("keeps the tab untouched when the engine has no transcript yet", async () => {
    const io = harness([engineTab({ vendor: "codex" })], "codex")
    const before = io.stateRef.current
    useTabNaming(io)
    await tick()
    expect(io.stateRef.current).toBe(before)
  })
})
