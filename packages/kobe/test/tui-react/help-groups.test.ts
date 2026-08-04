/**
 * Invariants for the shared help-dialog grouping (issue #15, G3) — consumed
 * by BOTH the Solid and React HelpDialogs. Declaration order is the visible
 * contract: the F1 help lists categories in the order the keymap declares
 * them, and every binding must land in exactly one group (a dropped row is
 * an invisible keybinding).
 */

import { describe, expect, it } from "vitest"
import type { KobeBinding } from "../../src/tui/context/keybindings"
import { grammarHelpSections, groupBindings } from "../../src/tui/lib/help-groups"

describe("groupBindings", () => {
  it("groups by category in declaration order, preserving row order", () => {
    const rows = [
      { id: "a", category: "Global" },
      { id: "b", category: "Tasks" },
      { id: "c", category: "Global" },
      { id: "d", category: "Tasks" },
    ]
    const grouped = groupBindings(rows)
    expect(grouped.map((g) => g.category)).toEqual(["Global", "Tasks"])
    expect(grouped[0]?.rows.map((r) => r.id)).toEqual(["a", "c"])
    expect(grouped[1]?.rows.map((r) => r.id)).toEqual(["b", "d"])
    // No binding lost or duplicated across groups.
    expect(grouped.flatMap((g) => g.rows)).toHaveLength(rows.length)
  })

  it("returns an empty list for an empty keymap", () => {
    expect(groupBindings([])).toEqual([])
  })
})

describe("grammarHelpSections", () => {
  const rows: KobeBinding[] = [
    {
      id: "help",
      scope: "global",
      keys: ["f1"],
      category: "Global",
      description: "Help",
      presentation: "onePress",
    },
    { id: "local", scope: "sidebar", keys: ["j"], category: "Sidebar", description: "Move" },
    { id: "modified-local", scope: "sidebar", keys: ["ctrl+p"], category: "Sidebar", description: "Filter" },
    { id: "more", scope: "global", keys: [], prefixKeys: ["f"], category: "Global", description: "Fork" },
    { id: "file", scope: "files", keys: ["o"], category: "Files", description: "Open" },
  ]

  it("teaches focused, one-press, and prefix gestures before other panes", () => {
    const sections = grammarHelpSections(rows, "sidebar", "ctrl+a")
    expect(sections.map((section) => section.kind)).toEqual(["here", "direct", "prefix", "other"])
    expect(sections[0]?.rows.map((row) => row.binding.id)).toEqual(["local", "modified-local"])
    expect(sections[1]?.rows.map((row) => row.binding.id)).toEqual(["help"])
    expect(sections[2]?.rows[0]?.primary).toBe("ctrl+a + f")
    expect(sections[3]?.scope).toBe("files")
  })

  it("does not advertise the Kobe prefix inside the embedded terminal", () => {
    const sections = grammarHelpSections(rows, "terminal", "ctrl+a")
    expect(sections.some((section) => section.kind === "prefix")).toBe(false)
  })

  it("uses the live stack snapshot to hide inactive submode bindings", () => {
    const sections = grammarHelpSections(rows, "sidebar", "ctrl+a", {
      direct: new Set(["help", "local"]),
      prefix: new Set(["more"]),
    })
    expect(sections.find((section) => section.kind === "here")?.rows.map((row) => row.binding.id)).toEqual(["local"])
    expect(sections.find((section) => section.kind === "direct")?.rows.map((row) => row.binding.id)).toEqual(["help"])
    expect(sections.find((section) => section.kind === "prefix")?.rows.map((row) => row.binding.id)).toEqual(["more"])
  })
})
