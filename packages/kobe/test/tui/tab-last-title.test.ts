import { describe, expect, it } from "vitest"
import { tabTitle } from "../../src/tui/workspace/terminal-tab-split.ts"
import {
  type TabsState,
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
const firstTab = (state: TabsState) => state.tabs[0]

describe("recorded live title (lastTitle)", () => {
  it("names a tab when no live stream is available, beating the first-prompt title", () => {
    let state = initialTabs()
    const id = firstTab(state)?.id as string
    state = setTabAutoTitle(state, id, "add a login form")
    // What the Inbox sees today: no liveName argument.
    expect(tabTitle(firstTab(state) as never, "claude")).toBe("add a login form")

    state = setTabLastTitle(state, id, "fixing the flaky watcher test")
    expect(tabTitle(firstTab(state) as never, "claude")).toContain("fixing the flaky watcher test")
  })

  it("a genuinely live title still outranks the recorded one", () => {
    let state = initialTabs()
    const id = firstTab(state)?.id as string
    state = setTabLastTitle(state, id, "stale name")
    expect(tabTitle(firstTab(state) as never, "claude", "live name")).toContain("live name")
  })

  it("a manual rename outranks both", () => {
    let state = initialTabs()
    const id = firstTab(state)?.id as string
    state = setTabLastTitle(state, id, "recorded")
    const renamed = { ...(firstTab(state) as never), title: "my tab" }
    expect(tabTitle(renamed, "claude", "live")).toBe("my tab")
  })

  it("recording the same title twice returns the SAME state — no snapshot churn", () => {
    let state = initialTabs()
    const id = firstTab(state)?.id as string
    state = setTabLastTitle(state, id, "running tests")
    expect(setTabLastTitle(state, id, "running tests")).toBe(state)
    expect(setTabLastTitle(state, "no-such-tab", "x")).toBe(state)
  })
})
