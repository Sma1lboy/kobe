import { describe, expect, it } from "vitest"
import {
  MAX_SPLIT_DEPTH,
  type SplitGroup,
  cycleLeaf,
  focusLeaf,
  initialSplit,
  leaves,
  removeLeaf,
  renameLeaf,
  splitActive,
} from "../../src/tui/workspace/split-core"
import { type EngineTab, splitLeafNames, splitLeafPtyKey, tabTitle } from "../../src/tui/workspace/terminal-tabs-core"

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

  it(`splits past MAX_SPLIT_DEPTH (${MAX_SPLIT_DEPTH}) no-op; siblings still allowed`, () => {
    // Alternate orientations so every split nests one level deeper.
    let s = initialSplit<string[] | null>(MAIN)
    for (let i = 0; i < MAX_SPLIT_DEPTH; i++) {
      s = splitActive(s, i % 2 === 0 ? "row" : "column", SH)
    }
    const atCap = s
    // One more alternating split would nest to depth 5 — refused.
    expect(splitActive(atCap, MAX_SPLIT_DEPTH % 2 === 0 ? "row" : "column", SH)).toBe(atCap)
    // A same-orientation split inserts a sibling (no deeper) — allowed.
    const sibling = splitActive(atCap, MAX_SPLIT_DEPTH % 2 === 0 ? "column" : "row", SH)
    expect(leaves(sibling.root)).toHaveLength(leaves(atCap.root).length + 1)
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
    expect(auto.get("leaf-2")).toBe("shell")
    expect(auto.get("leaf-3")).toBe("shell 2")
    const renamed = splitLeafNames(leaves(renameLeaf(s, "leaf-2", "logs").root), ["claude"])
    expect(renamed.get("leaf-2")).toBe("logs")
    // A manual title never joins the dedupe pool — the remaining shell stays bare.
    expect(renamed.get("leaf-3")).toBe("shell")
  })

  it("splitLeafNames: the engine leaf (null content) uses the first-prompt title when given", () => {
    const s = splitActive(initialSplit(MAIN), "row", SH) // engine(leaf-1) | shell(leaf-2)
    // With a first-prompt title, the engine leaf shows it (matching the tab
    // label); the shell leaf is a generic "shell".
    const named = splitLeafNames(leaves(s.root), ["claude"], "fix the resize race")
    expect(named.get("leaf-1")).toBe("fix the resize race")
    expect(named.get("leaf-2")).toBe("shell")
    // No title yet → falls back to the command basename.
    expect(splitLeafNames(leaves(s.root), ["claude"], null).get("leaf-1")).toBe("claude")
  })

  // Why: a split shell leaf's label was hard-coded "shell" forever, unlike
  // a real terminal tab that tracks the foreground process (OSC 0/2 title
  // escape) — "zsh" idle, "vim"/"htop" once you run one. `liveTitles` is
  // the shell leaf's counterpart to the engine leaf's `engineTitle`.
  it("splitLeafNames: a shell leaf's live foreground title wins over the generic default", () => {
    const s = splitActive(initialSplit(MAIN), "row", SH) // engine(leaf-1) | shell(leaf-2)
    const live = new Map([["leaf-2", "vim"]])
    const named = splitLeafNames(leaves(s.root), ["claude"], "fix the resize race", live)
    expect(named.get("leaf-2")).toBe("vim")
    // No live title yet → the generic default, same as before this existed.
    expect(splitLeafNames(leaves(s.root), ["claude"], "fix the resize race").get("leaf-2")).toBe("shell")
    // A manual rename still wins over a live title.
    const renamed = splitLeafNames(leaves(renameLeaf(s, "leaf-2", "logs").root), ["claude"], null, live)
    expect(renamed.get("leaf-2")).toBe("logs")
  })

  // Why: a SHELL tab's own leaf (leaf-1, null content) runs zsh and can
  // enter claude/vim — the static command basename froze its corner tag
  // on "zsh" forever. Live title fills in when there's no engine title;
  // an engine tab's conversation title still wins.
  it("splitLeafNames: leaf-1 uses its live title when there is no engine title", () => {
    const s = splitActive(initialSplit(MAIN), "row", SH) // leaf-1 | shell(leaf-2)
    const live = new Map([["leaf-1", "claude"]])
    // Shell tab (no engine title): the live foreground process wins over "zsh".
    expect(splitLeafNames(leaves(s.root), ["/bin/zsh"], null, live).get("leaf-1")).toBe("claude")
    // Engine tab: the first-prompt title still outranks the live title.
    expect(splitLeafNames(leaves(s.root), ["claude"], "fix the resize race", live).get("leaf-1")).toBe(
      "fix the resize race",
    )
  })
})

// Why: tabTitle is the ONE naming rule for the strip label, the rename
// dialog prefill, and notification titles (owner order 2026-07-09:
// rename > live process > first-prompt > vendor default). Deriving from
// anything else relabelled running tabs — pin the precedence and the
// split-tab branches ("group N" / a collapsed sole shell leaf).
describe("tabTitle (tab naming policy)", () => {
  const engine = (over: Partial<EngineTab> = {}): EngineTab => ({
    kind: "engine",
    id: "tab-1",
    title: null,
    ordinal: 1,
    ...over,
  })

  it("precedence: rename > live process > first-prompt > vendor default", () => {
    const full = engine({ title: "my name", autoTitle: "fix the resize race" })
    expect(tabTitle(full, "claude", "vim")).toBe("my name")
    // No rename → the live foreground process names the tab.
    expect(tabTitle(engine({ autoTitle: "fix the resize race" }), "claude", "vim")).toBe("vim 1")
    // No live title yet → the conversation's first-prompt title.
    expect(tabTitle(engine({ autoTitle: "fix the resize race" }), "claude")).toBe("fix the resize race")
    // Nothing at all → "$vendorCommand $ordinal"; a per-tab vendor pin
    // outranks the task vendor; command tabs fall back to the shell name.
    expect(tabTitle(engine(), "claude")).toBe("claude 1")
    expect(tabTitle(engine({ vendor: "codex" }), "claude")).toBe("codex 1")
    expect(tabTitle({ kind: "command", id: "tab-2", title: null, ordinal: 2, command: ["/bin/zsh"] }, "claude")).toBe(
      "shell 2",
    )
  })

  it("a multi-leaf split tab is a 'group N'; a rename still wins", () => {
    const tree = splitActive(initialSplit(MAIN), "row", SH) // leaf-1 | leaf-2
    expect(tabTitle(engine({ ordinal: 3, splitTree: tree }), "claude", "vim")).toBe("group 3")
    expect(tabTitle(engine({ ordinal: 3, splitTree: tree, title: "my group" }), "claude")).toBe("my group")
  })

  it("collapsed to a sole NON-engine leaf: leaf rename, else live process, else shell", () => {
    const split = splitActive(initialSplit(MAIN), "row", SH)
    const soleShell = removeLeaf(split, "leaf-1") // only leaf-2 (shell) survives
    expect(soleShell).not.toBeNull()
    if (!soleShell) return
    expect(tabTitle(engine({ splitTree: soleShell }), "claude", "vim")).toBe("vim 1")
    expect(tabTitle(engine({ splitTree: soleShell }), "claude")).toBe("shell 1")
    const renamed = renameLeaf(soleShell, "leaf-2", "logs")
    expect(tabTitle(engine({ splitTree: renamed }), "claude", "vim")).toBe("logs")
    // A sole surviving leaf-1 is the pristine engine — normal precedence.
    const soleEngine = removeLeaf(split, "leaf-2")
    if (soleEngine) expect(tabTitle(engine({ splitTree: soleEngine }), "claude")).toBe("claude 1")
  })
})
