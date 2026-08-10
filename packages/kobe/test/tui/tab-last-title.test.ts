import { describe, expect, it } from "vitest"
import { tabTitle } from "../../src/tui/workspace/terminal-tab-split.ts"
import {
  type TabsState,
  type TerminalTab,
  initialTabs,
  setTabAutoTitle,
  setTabLastTitle,
} from "../../src/tui/workspace/terminal-tabs-core.ts"

/**
 * The Inbox renders tabs it does not host, so it has no LIVE title stream —
 * before `lastTitle` it fell through to `autoTitle`, the first prompt's
 * summary, and a long-running conversation kept showing its opening
 * question forever.
 */
function firstTab(state: TabsState): TerminalTab {
  const tab = state.tabs[0]
  if (!tab) throw new Error("initialTabs() produced no tabs")
  return tab
}

describe("recorded live title (lastTitle)", () => {
  it("names a tab when no live stream is available, beating the first-prompt title", () => {
    let state = initialTabs()
    const id = firstTab(state).id
    state = setTabAutoTitle(state, id, "add a login form")
    // What the Inbox sees: tabTitle called with no liveName argument.
    expect(tabTitle(firstTab(state), "claude")).toBe("add a login form")

    state = setTabLastTitle(state, id, "fixing the flaky watcher test")
    expect(tabTitle(firstTab(state), "claude")).toContain("fixing the flaky watcher test")
  })

  it("a genuinely live title still outranks the recorded one", () => {
    const state = setTabLastTitle(initialTabs(), firstTab(initialTabs()).id, "stale name")
    expect(tabTitle(firstTab(state), "claude", "live name")).toContain("live name")
  })

  it("a manual rename outranks both", () => {
    const state = setTabLastTitle(initialTabs(), firstTab(initialTabs()).id, "recorded")
    const renamed: TerminalTab = { ...firstTab(state), title: "my tab" }
    expect(tabTitle(renamed, "claude", "live")).toBe("my tab")
  })

  // Regression (owner report 2026-08-10): "the chattab shows the right title
  // for a second, then goes back to claude 7." The live-title store seeded a
  // freshly-attached PTY with "" (nothing reported YET), the host recorded
  // that over the real name, and the tab fell to its vendor default — then
  // persisted, so it came back wrong on the next start too.
  it("an empty title never erases the recorded one", () => {
    const state = setTabLastTitle(initialTabs(), firstTab(initialTabs()).id, "✳ 运行本地Codex处理图片")
    const blanked = setTabLastTitle(state, firstTab(state).id, "")
    expect(blanked).toBe(state)
    expect(tabTitle(firstTab(blanked), "claude")).toContain("✳ 运行本地Codex处理图片")
  })

  it("recording the same title twice returns the SAME state — no snapshot churn", () => {
    const state = setTabLastTitle(initialTabs(), firstTab(initialTabs()).id, "running tests")
    expect(setTabLastTitle(state, firstTab(state).id, "running tests")).toBe(state)
    expect(setTabLastTitle(state, "no-such-tab", "x")).toBe(state)
  })
})
