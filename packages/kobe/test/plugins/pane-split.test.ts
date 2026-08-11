import { describe, expect, it } from "vitest"
import { closePluginPanes, openPluginPane } from "../../src/tui/workspace/pane-split"
import { leaves } from "../../src/tui/workspace/split-core"
import { initialTabs, openContentTab } from "../../src/tui/workspace/terminal-tabs-core"

const ARGV = ["sh", "-lc", "exec lazygit"] as const

describe("openPluginPane", () => {
  it("default: splits the focused chattab into a group beside the engine", () => {
    const state = initialTabs()
    const next = openPluginPane(state, ARGV, "lazygit")
    expect(next.tabs).toHaveLength(state.tabs.length) // no new tab
    const active = next.tabs.find((t) => t.id === next.activeId)
    const tree = active?.kind === "engine" || active?.kind === "command" ? active.splitTree : null
    expect(tree).toBeTruthy()
    const ls = leaves((tree as NonNullable<typeof tree>).root)
    expect(ls).toHaveLength(2)
    // leaf-1 stays the engine (null content); the new leaf runs the pane argv with its title.
    expect(ls[0]).toMatchObject({ id: "leaf-1", content: null })
    expect(ls[1]).toMatchObject({ content: ARGV, title: "lazygit" })
  })

  it("direction down: stacks the new pane below (column group)", () => {
    const state = initialTabs()
    const next = openPluginPane(state, ARGV, "lazygit", "split", "down")
    const active = next.tabs.find((t) => t.id === next.activeId)
    const tree = active?.kind === "engine" || active?.kind === "command" ? active.splitTree : null
    expect(tree?.root).toMatchObject({ kind: "group", orientation: "column" })
  })

  it("placement tab: opens a separate command tab instead", () => {
    const state = initialTabs()
    const next = openPluginPane(state, ARGV, "lazygit", "tab")
    expect(next.tabs).toHaveLength(state.tabs.length + 1)
    const active = next.tabs.find((t) => t.id === next.activeId)
    expect(active).toMatchObject({ kind: "command", command: ARGV, title: "lazygit" })
  })

  it("falls back to a tab when the size gate rejects the split", () => {
    const state = initialTabs()
    // 30 cols can't hold two ≥20-col panes → command tab instead.
    const next = openPluginPane(state, ARGV, "lazygit", "split", "right", { cols: 30, rows: 24 })
    expect(next.tabs).toHaveLength(state.tabs.length + 1)
    expect(next.tabs.find((t) => t.id === next.activeId)).toMatchObject({ kind: "command", command: ARGV })
  })

  it("splits normally when the size gate passes", () => {
    const state = initialTabs()
    const next = openPluginPane(state, ARGV, "lazygit", "split", "right", { cols: 120, rows: 40 })
    expect(next.tabs).toHaveLength(state.tabs.length)
  })

  it("falls back to a tab when the active tab cannot host a split", () => {
    const withContent = openContentTab(initialTabs(), "README.md", "README.md")
    const next = openPluginPane(withContent, ARGV, "lazygit")
    expect(next.tabs).toHaveLength(withContent.tabs.length + 1)
    expect(next.tabs.find((t) => t.id === next.activeId)?.kind).toBe("command")
  })
})

describe("closePluginPanes", () => {
  it("prunes matching titled leaves and reports them; engine leaf survives", () => {
    let state = openPluginPane(initialTabs(), ARGV, "fx")
    state = openPluginPane(state, ARGV, "fx", "split", "down")
    state = openPluginPane(state, ARGV, "keep")
    const tabId = state.activeId
    const { next, closedLeaves, closedTabIds } = closePluginPanes(state, "fx")
    expect(closedTabIds).toEqual([])
    expect(closedLeaves).toHaveLength(2)
    expect(closedLeaves.every((c) => c.tabId === tabId)).toBe(true)
    const tab = next.tabs.find((t) => t.id === tabId)
    const tree = tab?.kind === "engine" || tab?.kind === "command" ? tab.splitTree : null
    const remaining = leaves((tree as NonNullable<typeof tree>).root)
    expect(remaining.map((l) => l.title ?? null)).toEqual([null, "keep"]) // engine + the other pane
  })

  it("names matching command tabs for closing and no-ops on no match", () => {
    const state = openPluginPane(initialTabs(), ARGV, "fx", "tab")
    const { next, closedTabIds } = closePluginPanes(state, "fx")
    expect(closedTabIds).toEqual([state.activeId])
    const untouched = closePluginPanes(state, "nope")
    expect(untouched.next).toBe(state)
    expect(untouched.closedLeaves).toEqual([])
    expect(untouched.closedTabIds).toEqual([])
    void next
  })
})
