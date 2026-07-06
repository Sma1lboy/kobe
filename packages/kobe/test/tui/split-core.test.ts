/**
 * Why this matters: the split tree IS the tmux-pane contract inside one
 * workspace surface (issue #16) — same-orientation splits become
 * siblings, cross-orientation splits nest, finished leaves collapse
 * their group, and the tree stays content-agnostic (leaves carry an
 * opaque payload). The terminal adapter's key rule — `leaf-1` keeps the
 * tab-level PTY key so the engine session survives the first split —
 * is pinned here too via `splitLeafPtyKey`. A regression scrambles
 * leaf→resource mapping and kills or orphans live engine processes.
 */

import { describe, expect, it } from "vitest"
import {
  type SplitGroup,
  cycleLeaf,
  focusLeaf,
  initialSplit,
  leaves,
  removeLeaf,
  splitActive,
} from "../../src/tui/workspace/split-core"
import { splitLeafPtyKey } from "../../src/tui/workspace/terminal-tabs-core"

/** Terminal-flavored payload in these tests; the tree never inspects it. */
const MAIN = null
const SH = ["/bin/zsh"]

describe("split tree (content-agnostic)", () => {
  it("starts as a single leaf with no groups", () => {
    const s = initialSplit(MAIN)
    expect(s.root).toEqual({ kind: "leaf", id: "leaf-1", content: MAIN })
    expect(s.activeLeafId).toBe("leaf-1")
  })

  it("first split nests a group and focuses the new leaf", () => {
    const s = splitActive(initialSplit(MAIN), "row", SH)
    expect(s.root).toEqual({
      kind: "group",
      orientation: "row",
      children: [
        { kind: "leaf", id: "leaf-1", content: MAIN },
        { kind: "leaf", id: "leaf-2", content: SH },
      ],
    })
    expect(s.activeLeafId).toBe("leaf-2")
  })

  it("same-orientation split inserts a sibling after the active leaf", () => {
    let s = splitActive(initialSplit(MAIN), "row", SH) // [1 | 2*]
    s = focusLeaf(s, "leaf-1")
    s = splitActive(s, "row", SH) // [1 | 3* | 2]
    expect(leaves(s.root).map((l) => l.id)).toEqual(["leaf-1", "leaf-3", "leaf-2"])
    expect((s.root as SplitGroup<unknown>).children).toHaveLength(3)
  })

  it("cross-orientation split nests a group under the active leaf (tmux nesting)", () => {
    let s = splitActive(initialSplit(MAIN), "row", SH) // [1 | 2*]
    s = splitActive(s, "column", SH) // [1 | [2 / 3*]]
    const root = s.root as SplitGroup<unknown>
    expect(root.orientation).toBe("row")
    expect(root.children[1]).toEqual({
      kind: "group",
      orientation: "column",
      children: [
        { kind: "leaf", id: "leaf-2", content: SH },
        { kind: "leaf", id: "leaf-3", content: SH },
      ],
    })
    expect(s.activeLeafId).toBe("leaf-3")
  })

  it("removeLeaf collapses 1-child groups and refocuses the previous leaf", () => {
    let s = splitActive(initialSplit(MAIN), "row", SH) // [1 | 2*]
    s = splitActive(s, "column", SH) // [1 | [2 / 3*]]
    const removed = removeLeaf(s, "leaf-3")
    expect(removed).not.toBeNull()
    // The 1-child column group collapsed back into the row.
    expect(removed?.root).toEqual({
      kind: "group",
      orientation: "row",
      children: [
        { kind: "leaf", id: "leaf-1", content: MAIN },
        { kind: "leaf", id: "leaf-2", content: SH },
      ],
    })
    expect(removed?.activeLeafId).toBe("leaf-2")
  })

  it("removeLeaf returns null for the last leaf — the caller owns what happens next", () => {
    expect(removeLeaf(initialSplit(MAIN), "leaf-1")).toBeNull()
  })

  it("removeLeaf is a no-op for unknown ids", () => {
    const s = splitActive(initialSplit(MAIN), "row", SH)
    expect(removeLeaf(s, "leaf-99")).toBe(s)
  })

  it("cycleLeaf wraps reading order both ways; focusLeaf ignores unknown ids", () => {
    let s = splitActive(initialSplit(MAIN), "row", SH) // [1 | 2*]
    s = splitActive(s, "column", SH) // order: 1, 2, 3*
    expect(cycleLeaf(s, 1).activeLeafId).toBe("leaf-1")
    expect(cycleLeaf(s, -1).activeLeafId).toBe("leaf-2")
    expect(cycleLeaf(initialSplit(MAIN), 1).activeLeafId).toBe("leaf-1")
    expect(focusLeaf(s, "leaf-99")).toBe(s)
    expect(focusLeaf(s, "leaf-1").activeLeafId).toBe("leaf-1")
  })

  it("leaf ids are never reused after a close (monotonic ordinals)", () => {
    let s = splitActive(initialSplit(MAIN), "row", SH) // 1, 2
    const r = removeLeaf(s, "leaf-2")
    expect(r).not.toBeNull()
    if (!r) return
    s = splitActive(r, "row", SH)
    expect(leaves(s.root).map((l) => l.id)).toEqual(["leaf-1", "leaf-3"])
  })

  it("splitLeafPtyKey: leaf-1 keeps the TAB-level PTY key; later leaves namespace under it", () => {
    expect(splitLeafPtyKey("task::tab-1", "leaf-1")).toBe("task::tab-1")
    expect(splitLeafPtyKey("task::tab-1", "leaf-2")).toBe("task::tab-1::leaf-2")
  })
})
