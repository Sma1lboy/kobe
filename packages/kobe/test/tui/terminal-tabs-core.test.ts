/**
 * Why this matters: these transitions ARE the chattab contract carried
 * into the PTY world (issue #16) — new-tab placement, the can't-close-last
 * guard, left-neighbor focus on close, wrap-around cycling, and the
 * never-reused registry key. A regression silently kills or orphans live
 * engine PTYs (each tab id keys one).
 */

import { describe, expect, it } from "vitest"
import {
  addTab,
  closeActiveTab,
  cycleTab,
  initialTabs,
  openEditorTab,
  renameActiveTab,
  tabPtyKey,
  tabToShell,
} from "../../src/tui/workspace/terminal-tabs-core"

describe("terminal tabs state", () => {
  it("starts with one untitled active tab", () => {
    const s = initialTabs()
    expect(s.tabs).toHaveLength(1)
    expect(s.activeId).toBe("tab-1")
    expect(s.tabs[0].title).toBeNull()
  })

  it("addTab inserts after the active tab, focuses it, never reuses ids", () => {
    let s = addTab(initialTabs()) // [1, 2*]
    s = cycleTab(s, -1) // [1*, 2]
    s = addTab(s) // [1, 3*, 2]
    expect(s.tabs.map((t) => t.ordinal)).toEqual([1, 3, 2])
    expect(s.activeId).toBe("tab-3")
    const { state: closed } = closeActiveTab(s)
    const reAdded = addTab(closed)
    expect(reAdded.tabs.some((t) => t.id === "tab-3")).toBe(false)
    expect(reAdded.activeId).toBe("tab-4")
  })

  it("closeActiveTab focuses the left neighbor and refuses on the last tab", () => {
    const s = addTab(addTab(initialTabs())) // [1, 2, 3*]
    const first = closeActiveTab(s)
    expect(first.closedId).toBe("tab-3")
    expect(first.state.activeId).toBe("tab-2")
    const second = closeActiveTab(first.state)
    expect(second.state.activeId).toBe("tab-1")
    const last = closeActiveTab(second.state)
    expect(last.closedId).toBeNull()
    expect(last.state).toBe(second.state)
  })

  it("closing the FIRST tab focuses the right neighbor", () => {
    let s = addTab(initialTabs())
    s = cycleTab(s, 1) // wraps to tab-1 ([1*, 2])
    expect(s.activeId).toBe("tab-1")
    const { state } = closeActiveTab(s)
    expect(state.activeId).toBe("tab-2")
  })

  it("cycleTab wraps both directions and is a no-op with one tab", () => {
    const s = addTab(initialTabs()) // [1, 2*]
    expect(cycleTab(s, 1).activeId).toBe("tab-1")
    expect(cycleTab(s, -1).activeId).toBe("tab-1")
    expect(cycleTab(initialTabs(), 1).activeId).toBe("tab-1")
  })

  it("rename trims; blank clears back to the numbered default", () => {
    let s = renameActiveTab(initialTabs(), "  build watch  ")
    expect(s.tabs[0].title).toBe("build watch")
    s = renameActiveTab(s, "   ")
    expect(s.tabs[0].title).toBeNull()
  })

  it("tabPtyKey namespaces per task so tabs never collide across tasks", () => {
    expect(tabPtyKey("task-a", "tab-1")).not.toBe(tabPtyKey("task-b", "tab-1"))
    expect(tabPtyKey("task-a", "tab-1")).toBe("task-a::tab-1")
  })

  it("addTab carries an optional per-tab vendor override; plain new tabs have none", () => {
    const plain = addTab(initialTabs())
    expect(plain.tabs[1]).toMatchObject({ kind: "engine", vendor: undefined })
    const withEngine = addTab(initialTabs(), "codex")
    expect(withEngine.tabs[1]).toMatchObject({ kind: "engine", vendor: "codex" })
  })

  it("tabToShell degrades an engine tab in place — exiting the vendor CLI is allowed, not an error", () => {
    const s = renameActiveTab(addTab(initialTabs(), "codex"), "my agent") // [1, 2*(codex, titled)]
    const degraded = tabToShell(s, "tab-2", ["/bin/zsh"])
    const tab = degraded.tabs[1]
    // Same tab identity (id/title/ordinal survive; the PTY key must not
    // change) — now a command tab running a plain shell, the vendor pin
    // structurally gone with the kind switch.
    expect(tab).toEqual({ kind: "command", id: "tab-2", title: "my agent", ordinal: 2, command: ["/bin/zsh"] })
    expect(degraded.activeId).toBe("tab-2")
  })

  it("tabToShell never re-degrades command tabs (editor tabs keep their argv)", () => {
    const s = openEditorTab(initialTabs(), ["sh", "-c", "nvim x"], "x")
    const after = tabToShell(s, "tab-2", ["/bin/zsh"])
    expect(after.tabs[1]).toMatchObject({ kind: "command", command: ["sh", "-c", "nvim x"] })
    // Unknown id: state shape unchanged.
    expect(tabToShell(s, "tab-99", ["/bin/zsh"]).tabs).toEqual(s.tabs)
  })
})
