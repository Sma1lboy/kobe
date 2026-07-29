import { describe, expect, it } from "vitest"
import { openPluginPane } from "../../src/tui/workspace/pane-split"
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

  it("placement tab: opens a separate command tab instead", () => {
    const state = initialTabs()
    const next = openPluginPane(state, ARGV, "lazygit", "tab")
    expect(next.tabs).toHaveLength(state.tabs.length + 1)
    const active = next.tabs.find((t) => t.id === next.activeId)
    expect(active).toMatchObject({ kind: "command", command: ARGV, title: "lazygit" })
  })

  it("falls back to a tab when the active tab cannot host a split", () => {
    const withContent = openContentTab(initialTabs(), "README.md", "README.md")
    const next = openPluginPane(withContent, ARGV, "lazygit")
    expect(next.tabs).toHaveLength(withContent.tabs.length + 1)
    expect(next.tabs.find((t) => t.id === next.activeId)?.kind).toBe("command")
  })
})
