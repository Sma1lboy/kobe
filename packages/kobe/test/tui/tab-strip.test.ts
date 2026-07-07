import { describe, expect, it } from "vitest"
import { initialSplit, removeLeaf, splitActive } from "../../src/tui/workspace/split-core"
import { tabTitle } from "../../src/tui/workspace/tab-strip"
import type { EngineTab } from "../../src/tui/workspace/terminal-tabs-core"

const baseTab = (overrides: Partial<EngineTab> = {}): EngineTab => ({
  kind: "engine",
  id: "tab-1",
  title: null,
  ordinal: 1,
  ...overrides,
})

describe("tabTitle", () => {
  // Why: default names are "$process $ordinal" (owner naming 2026-07-07) —
  // a tab IS a terminal, its name says what runs in it, never "tab N".
  it("falls back through title -> autoTitle -> '$process $ordinal' when unsplit", () => {
    expect(tabTitle(baseTab(), "claude")).toBe("claude 1")
    expect(tabTitle(baseTab({ vendor: "codex" }), "claude")).toBe("codex 1")
    expect(tabTitle(baseTab({ autoTitle: "fix the resize race" }), "claude")).toBe("fix the resize race")
    expect(tabTitle(baseTab({ title: "my rename", autoTitle: "auto" }), "claude")).toBe("my rename")
  })

  it("labels a multi-leaf split as a group, regardless of live name", () => {
    const tree = splitActive(initialSplit(null), "row", ["/bin/zsh"])
    expect(tabTitle(baseTab({ splitTree: tree }), "claude")).toBe("group 1")
    expect(tabTitle(baseTab({ splitTree: tree }), "claude", "vim")).toBe("group 1")
  })

  // Why: once the engine leaf is closed the surviving shell IS the tab —
  // its live foreground-process name (OSC title stream) labels it, so
  // "claude exited" reads as "shell 1"/"vim 1", not a stale engine title.
  it("a solo non-engine leaf uses the live process name over the generic default", () => {
    const split = splitActive(initialSplit(null), "row", ["/bin/zsh"])
    const solo = removeLeaf(split, "leaf-1")
    expect(solo).not.toBeNull()
    if (!solo) throw new Error("unreachable")
    expect(tabTitle(baseTab({ splitTree: solo }), "claude")).toBe("shell 1")
    expect(tabTitle(baseTab({ splitTree: solo }), "claude", "vim")).toBe("vim 1")
    // A manual leaf rename still wins over a live title.
    const renamedSolo = { ...solo, root: { ...solo.root, title: "logs" } }
    expect(tabTitle(baseTab({ splitTree: renamedSolo }), "claude", "vim")).toBe("logs")
  })

  it("the pristine engine tab ignores the live name — its process is known by construction", () => {
    expect(tabTitle(baseTab({ autoTitle: "fix the resize race" }), "claude", "vim")).toBe("fix the resize race")
    expect(tabTitle(baseTab(), "claude", "vim")).toBe("claude 1")
  })
})
