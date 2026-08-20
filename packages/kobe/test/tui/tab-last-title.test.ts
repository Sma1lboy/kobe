import { describe, expect, it } from "vitest"
import { tabTitle, visibleNativeStatus } from "../../src/tui/workspace/terminal-tab-split.ts"
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

/**
 * Codex's OSC title is its THREAD ID until the thread is named, so the live
 * stream hands the ladder `01a00ee9-…` — an identifier, not a name. It must
 * lose to the tab's own first-prompt title (owner report 2026-08-17: "现在显示
 * 的是uuid"), which is what the naming pass derives from that very id.
 */
describe("placeholder live titles (codex thread ids)", () => {
  const THREAD_ID = "01a00ee9-f0e9-7503-a11c-83b4eface0f6"

  it("a thread id never names a codex tab — the first prompt does", () => {
    let state = initialTabs()
    const id = firstTab(state).id
    state = setTabAutoTitle(state, id, "add a login form")
    expect(tabTitle(firstTab(state), "codex", THREAD_ID)).toBe("add a login form")
    // Recorded (the Inbox / sidebar path) heals the same way, with no
    // migration of the snapshots that already hold one.
    state = setTabLastTitle(state, id, THREAD_ID)
    expect(tabTitle(firstTab(state), "codex")).toBe("add a login form")
  })

  it("with nothing else to say, the vendor default beats a raw id", () => {
    const state = initialTabs()
    expect(tabTitle(firstTab(state), "codex", THREAD_ID)).toBe(`codex ${firstTab(state).ordinal}`)
  })

  it("a NAMED codex thread still wins — the fallback heals itself", () => {
    let state = initialTabs()
    state = setTabAutoTitle(state, firstTab(state).id, "add a login form")
    expect(tabTitle(firstTab(state), "codex", "rework the parser")).toContain("rework the parser")
  })

  // The turn chip hides only while the engine's OWN status line is what the
  // row renders. A placeholder isn't rendered, so Rove draws its own state.
  it("rove's turn chip comes back when the id is not shown", () => {
    const state = initialTabs()
    expect(visibleNativeStatus(firstTab(state), "codex", "codex", THREAD_ID)).toBe(false)
    expect(visibleNativeStatus(firstTab(state), "codex", "codex", "rework the parser")).toBe(true)
  })

  it("claude's titles are untouched by the codex rule", () => {
    const state = setTabAutoTitle(initialTabs(), firstTab(initialTabs()).id, "add a login form")
    expect(tabTitle(firstTab(state), "claude", THREAD_ID)).toContain(THREAD_ID)
  })
})
