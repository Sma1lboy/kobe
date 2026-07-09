import { describe, expect, it } from "vitest"
import { initialSplit, removeLeaf, splitActive } from "../../src/tui/workspace/split-core"
import {
  addTab,
  closeActiveTab,
  cycleTab,
  hasEngineLeaf,
  initialTabs,
  markTabSpawned,
  openEditorTab,
  rehydrateTabs,
  renameActiveTab,
  selectTab,
  setTabAutoTitle,
  setTabSessionId,
  setTabSpawned,
  setTabSplit,
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

  it("selectTab jumps straight to a clicked tab, ignores unknown/already-active (no-op churn guard)", () => {
    const s = addTab(addTab(initialTabs())) // [1, 2, 3*]
    expect(selectTab(s, "tab-1").activeId).toBe("tab-1")
    expect(selectTab(s, "tab-99")).toBe(s)
    // Clicking the already-active tab returns the SAME reference — no new
    // object → the component skips the state.json write + re-render.
    expect(selectTab(s, s.activeId)).toBe(s)
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

  // Why: the ctrl+e "shell" pick opens a plain terminal tab through
  // openEditorTab with a NULL label — the tab must stay unnamed so the
  // live foreground-process title (tabTitle's liveName path) names it.
  it("openEditorTab with a null label leaves the tab unnamed (live title names it)", () => {
    const s = openEditorTab(initialTabs(), ["/bin/zsh"], null)
    expect(s.tabs[1]).toMatchObject({ kind: "command", title: null, command: ["/bin/zsh"] })
    expect(s.activeId).toBe("tab-2")
  })

  // Why: sessionId is the naming/resume anchor (tmux @kobe_session_id) —
  // it must land on engine tabs only and survive shell degradation is NOT
  // required (the conversation ended), but autoTitle must survive so a
  // degraded tab keeps the name of the conversation it hosted.
  it("setTabSessionId records the pinned id on engine tabs and ignores command tabs", () => {
    let s = setTabSessionId(initialTabs(), "tab-1", "uuid-1")
    expect(s.tabs[0]).toMatchObject({ kind: "engine", sessionId: "uuid-1" })
    s = openEditorTab(s, ["sh", "-c", "nvim x"], "x")
    const after = setTabSessionId(s, "tab-2", "uuid-2")
    expect(after.tabs[1]).not.toHaveProperty("sessionId", "uuid-2")
  })

  // Why: rehydrateTabs is the restart contract (issue #22, revised
  // 2026-07-07) — a tab is a TERMINAL, so every tab survives: engine tabs
  // come back resumable, command tabs (a degraded shell, a dead editor)
  // come back as plain shells. Dropping command tabs was the "closed
  // shell reopens as claude" bug: a lone degraded tab fell through to
  // initialTabs(), resurrecting a fresh engine in the terminal's place.
  it("rehydrateTabs keeps every tab; command tabs respawn as shells", () => {
    let s = addTab(initialTabs(), "codex") // [1, 2*(codex)]
    s = setTabSessionId(s, "tab-1", "uuid-1")
    s = openEditorTab(s, ["sh", "-c", "nvim x"], "x") // [1, 2, 3*(editor)]
    const back = rehydrateTabs(s, ["/bin/zsh"])
    expect(back.tabs.map((t) => t.id)).toEqual(["tab-1", "tab-2", "tab-3"])
    expect(back.activeId).toBe("tab-3")
    expect(back.tabs[0]).toMatchObject({ kind: "engine", sessionId: "uuid-1" })
    // The editor's process is gone — its terminal comes back as a shell.
    expect(back.tabs[2]).toMatchObject({ kind: "command", command: ["/bin/zsh"] })
    expect(back.nextOrdinal).toBe(s.nextOrdinal)
    // THE reported bug: a single tab whose engine exited (degraded to a
    // shell) must reopen as that shell, NOT as a fresh engine tab.
    const degraded = rehydrateTabs(tabToShell(initialTabs(), "tab-1", ["/bin/zsh"]), ["/bin/zsh"])
    expect(degraded.tabs).toHaveLength(1)
    expect(degraded.tabs[0]).toMatchObject({ kind: "command", id: "tab-1", command: ["/bin/zsh"] })
    // Corrupt/empty snapshot still falls back to a fresh initial state.
    expect(rehydrateTabs({ tabs: [], activeId: "tab-1", nextOrdinal: 1 }, ["/bin/zsh"])).toEqual(initialTabs())
  })

  // Why: the frozen split layout (owner ask 2026-07-06) must survive the
  // persist → rehydrate round-trip so a `claude | shell` group reopens
  // after restart. setTabSplit stores/clears the tree; rehydrateTabs keeps
  // it on the surviving engine tab. leaf-1 (null content = the tab's
  // engine) resumes via the tab's sessionId; the shell leaf respawns.
  it("setTabSplit persists a tab's split tree across rehydrate; null clears it", () => {
    const tree = splitActive(initialSplit(null), "row", ["/bin/zsh"]) // leaf-1 engine | leaf-2 shell
    let s = setTabSessionId(initialTabs(), "tab-1", "uuid-1")
    s = setTabSplit(s, "tab-1", tree)
    expect(s.tabs[0].splitTree).toEqual(tree)
    // Round-trip through JSON (state.json) then rehydrate — the layout
    // comes back intact on the resumable engine tab.
    const back = rehydrateTabs(JSON.parse(JSON.stringify(s)), ["/bin/zsh"])
    expect(back.tabs[0]).toMatchObject({ kind: "engine", sessionId: "uuid-1" })
    expect(back.tabs[0].splitTree).toEqual(tree)
    // Clearing (collapse to a single leaf) drops the tree → unsplit tab.
    expect(setTabSplit(s, "tab-1", null).tabs[0].splitTree).toBeNull()
    // Unknown id is a no-op (keeps state identity — write-churn guard).
    expect(setTabSplit(s, "tab-99", null)).toBe(s)
  })

  it("markTabSpawned flips once on engine tabs and is identity-stable after", () => {
    const s = markTabSpawned(initialTabs(), "tab-1")
    expect(s.tabs[0]).toMatchObject({ kind: "engine", spawned: true })
    const again = markTabSpawned(s, "tab-1")
    expect(again.tabs[0]).toBe(s.tabs[0])
  })

  // Why: the false direction is the restart-verification correction — a
  // persisted spawned=true whose session never conversed must be cleared
  // or the next start `--resume`s a nonexistent conversation (claude
  // errors "no conversation found" and the tab degrades to a shell).
  it("setTabSpawned corrects a stale spawned flag in both directions", () => {
    const up = setTabSpawned(initialTabs(), "tab-1", true)
    expect(up.tabs[0]).toMatchObject({ spawned: true })
    const down = setTabSpawned(up, "tab-1", false)
    expect(down.tabs[0]).toMatchObject({ spawned: false })
    // No-op keeps tab identity (persistence write-churn guard).
    expect(setTabSpawned(down, "tab-1", false).tabs[0]).toBe(down.tabs[0])
  })

  it("autoTitle fills the display gap under a manual title and survives degradation", () => {
    let s = setTabAutoTitle(initialTabs(), "tab-1", "fix the resize race")
    expect(s.tabs[0].autoTitle).toBe("fix the resize race")
    // Manual rename still wins at display time (title stays independent).
    s = renameActiveTab(s, "my name")
    expect(s.tabs[0].title).toBe("my name")
    expect(s.tabs[0].autoTitle).toBe("fix the resize race")
    // Degrading to a shell keeps the auto-derived name.
    const degraded = tabToShell(s, "tab-1", ["/bin/zsh"])
    expect(degraded.tabs[0].autoTitle).toBe("fix the resize race")
  })

  // Why: closing the engine leaf (`leaf-1`) inside a split keeps `kind:
  // "engine"` (57e3a20a — a surviving shell must not respawn the engine),
  // but its PTY is gone. Turn polling and the tab-strip chip must stop
  // treating this tab as a live engine, or the chip flaps against a dead
  // PTY — this predicate is the shared guard for both call sites.
  it("hasEngineLeaf tracks whether leaf-1 survives a split", () => {
    expect(hasEngineLeaf(null)).toBe(true)
    expect(hasEngineLeaf(undefined)).toBe(true)
    const split = splitActive(initialSplit(null), "row", ["/bin/zsh"])
    expect(hasEngineLeaf(split)).toBe(true) // leaf-1 (engine) + leaf-2 (shell)
    const engineClosed = removeLeaf(split, "leaf-1")
    expect(engineClosed).not.toBeNull()
    expect(hasEngineLeaf(engineClosed)).toBe(false) // only the shell survives
  })
})
