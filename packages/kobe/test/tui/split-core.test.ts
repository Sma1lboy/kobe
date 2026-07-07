import { describe, expect, it } from "vitest"
import {
  type SplitGroup,
  cycleLeaf,
  focusLeaf,
  initialSplit,
  leaves,
  removeLeaf,
  renameLeaf,
  splitActive,
} from "../../src/tui/workspace/split-core"
import { splitLeafNames, splitLeafPtyKey } from "../../src/tui/workspace/terminal-tabs-core"

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

  // Owner semantics 2026-07-06: the TAB is the "group"; each leaf carries
  // its OWN name — F2 rename wins, default = basename of what it runs,
  // duplicate defaults get a reading-order suffix so they stay tellable
  // apart. This pins the derivation the corner tags render from.
  it("renameLeaf sets a title, trims empty back to default, ignores unknown ids", () => {
    const s = splitActive(initialSplit(MAIN), "row", SH)
    const named = renameLeaf(s, "leaf-2", " logs ")
    expect(leaves(named.root).find((l) => l.id === "leaf-2")?.title).toBe("logs")
    const cleared = renameLeaf(named, "leaf-2", "   ")
    expect(leaves(cleared.root).find((l) => l.id === "leaf-2")?.title).toBeNull()
    expect(renameLeaf(s, "leaf-99", "x")).toBe(s)
  })

  it("splitLeafNames: rename wins; null content uses the tab command; duplicates get suffixes", () => {
    let s = splitActive(initialSplit(MAIN), "row", SH) // claude | zsh
    s = splitActive(s, "row", SH) // claude | zsh | zsh
    const auto = splitLeafNames(leaves(s.root), ["/usr/local/bin/claude", "--resume"])
    expect(auto.get("leaf-1")).toBe("claude")
    expect(auto.get("leaf-2")).toBe("zsh")
    expect(auto.get("leaf-3")).toBe("zsh 2")
    const renamed = splitLeafNames(leaves(renameLeaf(s, "leaf-2", "logs").root), ["claude"])
    expect(renamed.get("leaf-2")).toBe("logs")
    // A manual title never joins the dedupe pool — the remaining zsh stays bare.
    expect(renamed.get("leaf-3")).toBe("zsh")
  })
})
