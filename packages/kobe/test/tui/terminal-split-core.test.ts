/**
 * Why this matters: the split tree IS the tmux-pane contract inside one
 * terminal tab (issue #16) — same-orientation splits become siblings,
 * cross-orientation splits nest, exited panes collapse their group, and
 * `pane-1` keeps the tab-level PTY key so the engine session survives the
 * first split. A regression scrambles pane→PTY mapping and kills or
 * orphans live engine processes.
 */

import { describe, expect, it } from "vitest"
import {
  type SplitGroup,
  cycleLeaf,
  focusLeaf,
  initialSplit,
  leaves,
  paneKey,
  removeLeaf,
  splitActive,
} from "../../src/tui/workspace/terminal-split-core"

const SH = ["/bin/zsh"]

describe("terminal split tree", () => {
  it("starts as a single original pane with no groups", () => {
    const s = initialSplit()
    expect(s.root).toEqual({ kind: "leaf", id: "pane-1" })
    expect(s.activeLeafId).toBe("pane-1")
  })

  it("first split nests a group and focuses the new pane", () => {
    const s = splitActive(initialSplit(), "row", SH)
    expect(s.root).toEqual({
      kind: "group",
      orientation: "row",
      children: [
        { kind: "leaf", id: "pane-1" },
        { kind: "leaf", id: "pane-2", command: SH },
      ],
    })
    expect(s.activeLeafId).toBe("pane-2")
  })

  it("same-orientation split inserts a sibling after the active pane", () => {
    let s = splitActive(initialSplit(), "row", SH) // [1 | 2*]
    s = focusLeaf(s, "pane-1")
    s = splitActive(s, "row", SH) // [1 | 3* | 2]
    expect(leaves(s.root).map((l) => l.id)).toEqual(["pane-1", "pane-3", "pane-2"])
    expect((s.root as SplitGroup).children).toHaveLength(3)
  })

  it("cross-orientation split nests a group under the active pane (tmux nesting)", () => {
    let s = splitActive(initialSplit(), "row", SH) // [1 | 2*]
    s = splitActive(s, "column", SH) // [1 | [2 / 3*]]
    const root = s.root as SplitGroup
    expect(root.orientation).toBe("row")
    expect(root.children[1]).toEqual({
      kind: "group",
      orientation: "column",
      children: [
        { kind: "leaf", id: "pane-2", command: SH },
        { kind: "leaf", id: "pane-3", command: SH },
      ],
    })
    expect(s.activeLeafId).toBe("pane-3")
  })

  it("removeLeaf collapses 1-child groups and refocuses the previous pane", () => {
    let s = splitActive(initialSplit(), "row", SH) // [1 | 2*]
    s = splitActive(s, "column", SH) // [1 | [2 / 3*]]
    const removed = removeLeaf(s, "pane-3")
    expect(removed).not.toBeNull()
    // The 1-child column group collapsed back into the row.
    expect(removed?.root).toEqual({
      kind: "group",
      orientation: "row",
      children: [
        { kind: "leaf", id: "pane-1" },
        { kind: "leaf", id: "pane-2", command: SH },
      ],
    })
    expect(removed?.activeLeafId).toBe("pane-2")
  })

  it("removeLeaf returns null for the last pane — tab-level exit behavior takes over", () => {
    expect(removeLeaf(initialSplit(), "pane-1")).toBeNull()
  })

  it("removeLeaf is a no-op for unknown ids", () => {
    const s = splitActive(initialSplit(), "row", SH)
    expect(removeLeaf(s, "pane-99")).toBe(s)
  })

  it("cycleLeaf wraps reading order both ways; focusLeaf ignores unknown ids", () => {
    let s = splitActive(initialSplit(), "row", SH) // [1 | 2*]
    s = splitActive(s, "column", SH) // order: 1, 2, 3*
    expect(cycleLeaf(s, 1).activeLeafId).toBe("pane-1")
    expect(cycleLeaf(s, -1).activeLeafId).toBe("pane-2")
    expect(cycleLeaf(initialSplit(), 1).activeLeafId).toBe("pane-1")
    expect(focusLeaf(s, "pane-99")).toBe(s)
    expect(focusLeaf(s, "pane-1").activeLeafId).toBe("pane-1")
  })

  it("pane ids are never reused after a close (monotonic ordinals)", () => {
    let s = splitActive(initialSplit(), "row", SH) // 1, 2
    const r = removeLeaf(s, "pane-2")
    expect(r).not.toBeNull()
    if (!r) return
    s = splitActive(r, "row", SH)
    expect(leaves(s.root).map((l) => l.id)).toEqual(["pane-1", "pane-3"])
  })

  it("pane-1 keeps the TAB-level PTY key; later panes namespace under it", () => {
    expect(paneKey("task::tab-1", "pane-1")).toBe("task::tab-1")
    expect(paneKey("task::tab-1", "pane-2")).toBe("task::tab-1::pane-2")
  })
})
