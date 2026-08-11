/**
 * Golden behavior — tab-title derivation, anchored end to end (issue #11
 * Phase 1). Unlike the per-function suites (tab-title-stable, status-prefix,
 * tab-last-title), these walk the REAL recording chain a live session drives:
 *
 *   OSC title stream → entry-point strip (`stripEngineStatusPrefix`, the
 *   projection in useTitleSubscriptions/use-turn-polls) → recording
 *   (`setTabLastTitle`/`setTabLiveVendor`/`demoteExitedEngine`, the
 *   use-tab-turn-state effect) → display (`tabTitle`/`tabTitleStable`).
 *
 * These are the Phase 1 stakes for the 2026-08-10/11 title fixes
 * (982a996a, f2b6d744, 496c46ee, 57a6f9d7, e9405e07, 5d218f58): Phase 2's
 * running-state work must keep every one of them green.
 */

import { describe, expect, it } from "vitest"
import { stripEngineStatusPrefix } from "../../src/engine/registry"
import { demoteExitedEngine } from "../../src/tui/workspace/terminal-tab-identity"
import {
  type TabsState,
  type TerminalTab,
  initialTabs,
  setTabLastTitle,
  setTabLiveVendor,
  tabTitle,
  tabTitleStable,
} from "../../src/tui/workspace/terminal-tabs-core"
import type { VendorId } from "../../src/types/vendor"

const SHELL = ["/bin/zsh"]

/** One tick of the use-tab-turn-state recording effect for one tab: the
 *  projected (already-stripped) live title + the probe's vendor answer land
 *  on the persisted tab, demoting first when the engine exited. */
function recordTitle(state: TabsState, tabId: string, raw: string, live: VendorId | null): TabsState {
  const projected = stripEngineStatusPrefix(raw, live ?? undefined)
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) return state
  const demoted = demoteExitedEngine(tab, tab.liveVendor, live, SHELL)
  if (demoted !== tab) return { ...state, tabs: state.tabs.map((t) => (t.id === tabId ? demoted : t)) }
  let next = setTabLastTitle(state, tabId, projected)
  next = setTabLiveVendor(next, tabId, live)
  return next
}

const tabOf = (state: TabsState, id: string): TerminalTab => {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab) throw new Error(`no tab ${id}`)
  return tab
}

describe("golden: title stream → recording → display", () => {
  it("an engine's status stream records the NAME; the tree shows it beside kobe's own glyph", () => {
    let state = initialTabs()
    state = recordTitle(state, "tab-1", "✳ 修复构建失败", "claude")
    expect(tabOf(state, "tab-1").lastTitle).toBe("修复构建失败")
    expect(tabTitleStable(tabOf(state, "tab-1"), "claude", "claude")).toBe("修复构建失败 1")
    // The stream repeating the same title is a no-op — no snapshot churn.
    expect(recordTitle(state, "tab-1", "✳ 修复构建失败", "claude")).toBe(state)
  })

  it("the probe-blind window still strips — the union vocabulary, not a vendor gate", () => {
    // The ps-walk probe takes ~2s; until it answers there is NO vendor. The
    // strip must not wait for one (f2b6d744) — a raw `⠹ …` recorded in that
    // window is exactly the prefix that kept coming back.
    expect(stripEngineStatusPrefix("⠹ add the ruler", undefined)).toBe("add the ruler")
    expect(stripEngineStatusPrefix("✳ 修复构建失败", undefined)).toBe("修复构建失败")
    let state = initialTabs()
    state = setTabLastTitle(state, "tab-1", stripEngineStatusPrefix("⠹ add the ruler", undefined))
    expect(tabOf(state, "tab-1").lastTitle).toBe("add the ruler")
  })

  it("a blank live title never erases the recorded name (57a6f9d7)", () => {
    let state = initialTabs()
    state = recordTitle(state, "tab-1", "✳ 修复构建失败", "claude")
    const before = state
    // A dying engine can emit an empty OSC title on its way out.
    state = recordTitle(state, "tab-1", "", "claude")
    expect(state).toBe(before)
    expect(tabTitleStable(tabOf(state, "tab-1"), "claude", "claude")).toBe("修复构建失败 1")
  })

  it("a decoration-only title is recorded verbatim but never names the row", () => {
    let state = initialTabs()
    state = recordTitle(state, "tab-1", "✳", "claude")
    // The strip keeps a whole-title glyph (a session genuinely named "✳"
    // owns that name) …
    expect(tabOf(state, "tab-1").lastTitle).toBe("✳")
    // … but in the tree a lone glyph is not a label: fall to the default,
    // and to the first-prompt summary when there is a meaningful one.
    expect(tabTitleStable(tabOf(state, "tab-1"), "claude", "claude")).toBe("claude 1")
    const withAuto = { ...tabOf(state, "tab-1"), autoTitle: "wire up the digest verb" } as TerminalTab
    expect(tabTitleStable(withAuto, "claude", "claude")).toBe("wire up the digest verb")
    // First-prompt junk ("1", "y", bare punctuation) is not a label either.
    const withJunk = { ...tabOf(state, "tab-1"), autoTitle: "1" } as TerminalTab
    expect(tabTitleStable(withJunk, "claude", "claude")).toBe("claude 1")
  })

  it("engine exit demotes the tab to the shell it always was", () => {
    let state = initialTabs()
    state = recordTitle(state, "tab-1", "✳ 修复构建失败", "claude")
    // The engine exits; the probe CONFIRMS no engine (vendor → null edge).
    state = recordTitle(state, "tab-1", "zsh", null)
    const tab = tabOf(state, "tab-1")
    expect(tab.kind).toBe("command")
    expect(tab.lastTitle).toBeNull()
    expect(tab.liveVendor).toBeNull()
    // Neither the frozen status line nor the engine pin may keep naming it.
    expect(tabTitleStable(tab, "claude")).toBe("shell 1")
    // A manual rename survives the demotion — it is the user's name.
    let named = initialTabs()
    named = { ...named, tabs: named.tabs.map((t) => ({ ...t, title: "my tab" }) as TerminalTab) }
    named = recordTitle(named, "tab-1", "✳ working", "claude")
    named = recordTitle(named, "tab-1", "zsh", null)
    expect(tabTitleStable(tabOf(named, "tab-1"), "claude")).toBe("my tab")
  })

  it("typing an engine into a shell tab names the tab after that engine (e9405e07)", () => {
    const shellTab: TerminalTab = { kind: "command", command: SHELL, id: "tab-2", title: null, ordinal: 2 }
    let state: TabsState = { tabs: [shellTab], activeId: "tab-2", nextOrdinal: 3 }
    state = recordTitle(state, "tab-2", "✳ Herdr多Agent协作技巧分享", "claude")
    const tab = tabOf(state, "tab-2")
    expect(tab.liveVendor).toBe("claude")
    // The recorded conversation name wins …
    expect(tabTitleStable(tab, "claude", "claude")).toBe("Herdr多Agent协作技巧分享 2")
    // … and even title-less (decoration only), the row reads as the engine,
    // never "shell N" — including after a restart when only the RECORDED
    // identity is available (liveVendor probe not yet answered).
    let bare: TabsState = { tabs: [shellTab], activeId: "tab-2", nextOrdinal: 3 }
    bare = recordTitle(bare, "tab-2", "✳", "claude")
    expect(tabTitleStable(tabOf(bare, "tab-2"), "claude", undefined)).toBe("claude 2")
  })

  it("pre-fix recordings heal on display without a migration", () => {
    // Persisted snapshots from before the entry-point strip still carry the
    // status prefix; the display side strips again (idempotent).
    const stale: TerminalTab = {
      kind: "engine",
      id: "tab-1",
      title: null,
      ordinal: 1,
      lastTitle: "⠐ 利用自进化",
      liveVendor: "claude",
    } as TerminalTab
    expect(tabTitleStable(stale, "claude", "claude")).toBe("利用自进化 1")
    // A user WRAPPER vendor (custom id, declares no glyph vocabulary) heals
    // too — cleaning is not gated on `ownsStatus` (496c46ee).
    const wrapper = { ...stale, vendor: "claudecpa" } as TerminalTab
    expect(tabTitleStable(wrapper, "claudecpa" as VendorId, "claudecpa" as VendorId)).toBe("利用自进化 1")
  })

  it("display precedence: rename > live title > recording > first-prompt > vendor default", () => {
    let state = initialTabs()
    state = recordTitle(state, "tab-1", "✳ 修复构建失败", "claude")
    const tab = tabOf(state, "tab-1")
    // The live OSC title outranks the recording in the hosting strip …
    expect(tabTitle(tab, "claude", "重构侧边栏")).toBe("重构侧边栏 1")
    // … the recording carries surfaces that don't host the tab …
    expect(tabTitle(tab, "claude")).toBe("修复构建失败 1")
    // … and a manual rename beats them all.
    expect(tabTitle({ ...tab, title: "my tab" } as TerminalTab, "claude", "重构侧边栏")).toBe("my tab")
    // Pre-title fallbacks: meaningful first prompt, then the vendor default.
    const fresh = tabOf(initialTabs(), "tab-1")
    expect(tabTitle({ ...fresh, autoTitle: "wire up the digest verb" } as TerminalTab, "claude")).toBe(
      "wire up the digest verb",
    )
    expect(tabTitle(fresh, "claude")).toBe("claude 1")
  })
})
