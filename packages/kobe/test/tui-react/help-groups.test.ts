import { describe, expect, it } from "vitest"
import { groupBindings } from "../../src/tui/lib/help-groups"

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
    expect(grouped.flatMap((g) => g.rows)).toHaveLength(rows.length)
  })

  it("returns an empty list for an empty keymap", () => {
    expect(groupBindings([])).toEqual([])
  })
})
