import { describe, expect, it } from "vitest"
import { initialSplit, removeLeaf, splitActive } from "../../src/tui/workspace/split-core"
import {
  type EngineTab,
  type TabsState,
  addTab,
  closeActiveTab,
  collapseSplit,
  cycleTab,
  engineTabArgv,
  engineTabSpawnFor,
  findContentTab,
  hasEngineLeaf,
  initialTabs,
  isTabSplit,
  markTabSpawned,
  openCommandTab,
  openContentTab,
  openEditorTab,
  rehydrateTabs,
  renameActiveTab,
  selectTab,
  setTabAutoTitle,
  setTabSessionId,
  setTabSpawned,
  setTabSplit,
  shellCommandLine,
  shellSpawn,
  tabExitAction,
  tabPtyKey,
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

  // Why: the ctrl+e "shell" pick opens a plain command tab with a NULL
  // label — the tab must stay unnamed so the
  // live foreground-process title (tabTitle's liveName path) names it.
  it("openCommandTab with a null label leaves the tab unnamed (live title names it)", () => {
    const s = openCommandTab(initialTabs(), ["/bin/zsh"], null)
    expect(s.tabs[1]).toMatchObject({ kind: "command", title: null, command: ["/bin/zsh"] })
    expect(s.activeId).toBe("tab-2")
  })

  // Regression (2026-07-10): FileTree opens share one File tab. Opening a
  // second file replaces and focuses that slot instead of growing one editor
  // tab per file forever.
  it("openEditorTab reuses the single editor slot", () => {
    let s = openEditorTab(initialTabs(), ["nvim", "a.ts"], "a.ts")
    const editorId = s.activeId
    s = openEditorTab(s, ["nvim", "b.ts"], "b.ts")

    expect(s.tabs).toHaveLength(2)
    expect(s.activeId).toBe(editorId)
    expect(s.tabs[1]).toMatchObject({
      kind: "command",
      id: editorId,
      title: "b.ts",
      command: ["nvim", "b.ts"],
      purpose: "editor",
    })
  })

  it("the singleton editor slot does not replace a user-opened shell tab", () => {
    let s = openCommandTab(initialTabs(), ["/bin/zsh"], null)
    const shellId = s.activeId
    s = openEditorTab(s, ["nvim", "a.ts"], "a.ts")
    s = openEditorTab(s, ["nvim", "b.ts"], "b.ts")

    expect(s.tabs).toHaveLength(3)
    const shellTab = s.tabs.find((tab) => tab.id === shellId)
    expect(shellTab).toMatchObject({ kind: "command" })
    expect(shellTab).not.toHaveProperty("purpose")
    expect(s.tabs.filter((tab) => tab.kind === "command" && tab.purpose === "editor")).toHaveLength(1)
  })

  it("openContentTab opens then reuses the single read-only preview slot", () => {
    let s = openContentTab(initialTabs(), "src/a.ts", "a.ts", "origin/main")
    const contentId = s.activeId
    expect(s.tabs).toHaveLength(2)
    expect(s.tabs[1]).toMatchObject({ kind: "content", id: contentId, relPath: "src/a.ts", base: "origin/main" })
    // A second `d` retargets the SAME tab in place (no pile-up), and drops
    // the base when opened in working scope.
    s = openContentTab(s, "src/b.ts", "b.ts")
    expect(s.tabs).toHaveLength(2)
    expect(s.activeId).toBe(contentId)
    expect(findContentTab(s)).toMatchObject({ relPath: "src/b.ts", base: undefined })
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
    expect(back.tabs[2]).toHaveProperty("purpose", undefined)
    expect(back.nextOrdinal).toBe(s.nextOrdinal)
    // THE reported bug: a single persisted COMMAND tab (a shell pick from
    // an older snapshot) must reopen as that shell, NOT as a fresh engine.
    const shellOnly = rehydrateTabs(
      {
        tabs: [{ kind: "command", id: "tab-1", title: null, ordinal: 1, command: ["/bin/zsh"] }],
        activeId: "tab-1",
        nextOrdinal: 2,
      },
      ["/bin/zsh"],
    )
    expect(shellOnly.tabs).toHaveLength(1)
    expect(shellOnly.tabs[0]).toMatchObject({ kind: "command", id: "tab-1", command: ["/bin/zsh"] })
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

  it("autoTitle fills the display gap under a manual title", () => {
    let s = setTabAutoTitle(initialTabs(), "tab-1", "fix the resize race")
    expect(s.tabs[0].autoTitle).toBe("fix the resize race")
    // Manual rename still wins at display time (title stays independent).
    s = renameActiveTab(s, "my name")
    expect(s.tabs[0].title).toBe("my name")
    expect(s.tabs[0].autoTitle).toBe("fix the resize race")
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

  // Why: this argv decision IS the restart-survival contract (issue #22) —
  // `--resume` must fire ONLY for a tab that already conversed and has no
  // live PTY; a live PTY (re-render churn) or a never-spawned tab must
  // keep pinning the fresh id, or claude errors "no conversation found".
  it("engineTabArgv: pin fresh, resume dead spawned sessions, bare when unpinnable", () => {
    const tab = (over: Partial<EngineTab>): EngineTab => ({
      kind: "engine",
      id: "tab-1",
      title: null,
      ordinal: 1,
      ...over,
    })
    const base = ["claude"] as const
    // No session id (codex/custom vendors) → the bare command, always.
    expect(engineTabArgv(tab({ sessionId: null }), base, false)).toEqual(["claude"])
    // Fresh tab (never spawned) → pin the id.
    expect(engineTabArgv(tab({ sessionId: "u1" }), base, false)).toEqual(["claude", "--session-id", "u1"])
    // Spawned + PTY still live (ordinary re-render) → keep pinning.
    expect(engineTabArgv(tab({ sessionId: "u1", spawned: true }), base, true)).toEqual(["claude", "--session-id", "u1"])
    // Spawned + PTY gone (host restart / degrade re-acquire) → resume.
    expect(engineTabArgv(tab({ sessionId: "u1", spawned: true }), base, false)).toEqual(["claude", "--resume", "u1"])
  })

  // Why: the quick-fork initial prompt (issue #17, delivery verified in
  // 12283c57) rides the argv as a positional arg ONLY on the first engine
  // tab's FIRST spawn — any wider and the prompt re-delivers on re-render
  // churn / restart / every new tab, replaying the fork message forever.
  it("engineTabSpawnFor: the initial prompt rides only the first engine tab's first spawn", () => {
    const s = addTab(initialTabs()) // [tab-1, tab-2*] — both engine
    const first = s.tabs[0] as EngineTab
    const second = s.tabs[1] as EngineTab
    const base = ["claude"] as const
    const opts = {
      live: false,
      shell: "/bin/zsh",
      prompt: "fix the bug",
      task: { id: "task-1", kind: "task" as const, vendor: "claude" as const, repo: "/repo" },
      worktreePath: "/repo/.worktrees/task-1",
      protocolGates: { status: () => false, notes: () => false, dispatcher: () => false },
    }
    expect(engineTabSpawnFor(s, first, base, opts)).toEqual({
      command: ["/bin/zsh", "-ilc", expect.stringContaining("claude 'fix the bug'; __rc=$?")],
    })
    // Second engine tab: never gets the prompt.
    expect(engineTabSpawnFor(s, second, base, opts).command[2]).not.toContain("fix the bug")
    // Already spawned: the conversation has begun — never re-deliver.
    const spawned = markTabSpawned(s, "tab-1")
    expect(engineTabSpawnFor(spawned, spawned.tabs[0] as EngineTab, base, opts).command[2]).not.toContain("fix the bug")
    // PTY still live (re-render churn): the running session keeps its input.
    expect(engineTabSpawnFor(s, first, base, { ...opts, live: true }).command[2]).not.toContain("fix the bug")
    // No prompt at all: the plain spawn.
    expect(engineTabSpawnFor(s, first, base, { ...opts, prompt: undefined }).command[2]).not.toContain("fix the bug")
    // "First" means first ENGINE tab, not tabs[0] — a leading command tab
    // (rehydrated shell) must not steal or block the delivery.
    const mixed: TabsState = {
      tabs: [
        { kind: "command", id: "tab-1", title: null, ordinal: 1, command: ["/bin/zsh"] },
        { kind: "engine", id: "tab-2", title: null, ordinal: 2 },
      ],
      activeId: "tab-2",
      nextOrdinal: 3,
    }
    expect(engineTabSpawnFor(mixed, mixed.tabs[1] as EngineTab, base, opts).command[2]).toContain(
      "claude 'fix the bug'",
    )
    // The prompt composes WITH the session pin: flags stay before the
    // positional first message so the vendor CLI parses both correctly.
    const pinned = setTabSessionId(s, "tab-1", "u1")
    expect(engineTabSpawnFor(pinned, pinned.tabs[0] as EngineTab, base, opts).command[2]).toContain(
      "claude --session-id u1 'fix the bug'",
    )
  })

  // Why: the exit policy decides between two irreversible side-effect
  // paths (close tab / one-shot resume). Engines run INSIDE the user's
  // shell (shellSpawn), so a live PTY exit means the shell ended → close;
  // the one-shot guard is load-bearing: without it a `--resume` that
  // itself dies respawns forever.
  it("tabExitAction: dead-on-attach resumes once; every other exit closes the tab", () => {
    const engine: EngineTab = { kind: "engine", id: "tab-1", title: null, ordinal: 1, sessionId: "u1", spawned: true }
    expect(
      tabExitAction({ kind: "command", id: "tab-2", title: null, ordinal: 2, command: ["zsh"] }, true, false),
    ).toBe("close")
    expect(tabExitAction(engine, true, false)).toBe("resume")
    expect(tabExitAction(engine, true, true)).toBe("close") // resume already tried once
    expect(tabExitAction(engine, false, false)).toBe("close") // live exit (user quit the shell)
    expect(tabExitAction({ ...engine, sessionId: null }, true, false)).toBe("close") // nothing to resume
    expect(tabExitAction({ ...engine, spawned: undefined }, true, false)).toBe("close") // never conversed
  })

  // Why: shellSpawn is the vendor-launch contract (2026-07-10): the PTY
  // runs the user's SHELL and the engine command is TYPED into it, so the
  // session keeps rc-file context and exiting the vendor lands on a
  // prompt. Quoting must keep an argv with spaces/quotes ONE argument at
  // an interactive prompt.
  it("shellSpawn wraps an engine argv in the user's shell with the line typed in", () => {
    expect(shellSpawn(["claude", "--session-id", "u1"], "/bin/zsh")).toEqual({
      command: ["/bin/zsh"],
      initialInput: "claude --session-id u1\r",
    })
    expect(shellCommandLine(["claude", "--append-system-prompt", "be terse"])).toBe(
      "claude --append-system-prompt 'be terse'",
    )
    // Embedded single quotes survive POSIX-style ('\'' splice); empty args stay quoted.
    expect(shellCommandLine(["echo", "it's", ""])).toBe("echo 'it'\\''s' ''")
  })

  // Why: tab identity reaches `kobe hook` as inherited env — an `env K=V`
  // PREFIX on the typed line (not the PTY environment), so it covers fresh
  // spawns and adopted warm shells in every backend, and fish (which
  // rejects the bare `K=V cmd` form). Without it, all tabs of a task are
  // indistinguishable to the daemon (same worktree cwd).
  it("shellSpawn env rides the typed line as an `env K=V` prefix", () => {
    expect(shellSpawn(["claude"], "/bin/zsh", { KOBE_TASK_ID: "t1", KOBE_TAB_ID: "tab-2" })).toEqual({
      command: ["/bin/zsh"],
      initialInput: "env KOBE_TASK_ID=t1 KOBE_TAB_ID=tab-2 claude\r",
    })
    // Empty env = the plain line, no `env` noise.
    expect(shellSpawn(["claude"], "/bin/zsh", {}).initialInput).toBe("claude\r")
  })

  // Why: the F7 attention jump's tab precision — the launch script exports
  // KOBE_TASK_ID/KOBE_TAB_ID ahead of the engine, hooks inherit it, and the
  // daemon can attribute activity to THIS tab (a task's tabs share one
  // worktree cwd). The keepAlive fallback shell inherits it too.
  it("engineTabSpawnFor exports the task+tab identity in the launch script", () => {
    const state = addTab(initialTabs()) // active: tab-2
    const tab = state.tabs[1] as EngineTab
    const spawn = engineTabSpawnFor(state, tab, ["claude"], {
      live: false,
      shell: "/bin/zsh",
      task: { id: "01TASK", kind: "task" },
      worktreePath: "/wt",
    })
    expect(spawn.command[2]).toContain("export KOBE_TASK_ID='01TASK' KOBE_TAB_ID='tab-2'\n")
  })

  // Why: collapse decides persistence (null = unsplit fast path) AND the
  // render path. Folding a sole surviving SHELL leaf would respawn the
  // engine over it — the tree must survive; only a pristine leaf-1 folds.
  it("collapseSplit folds only a sole-survivor leaf-1; isTabSplit gates the chord fall-through", () => {
    const unsplit = initialSplit<readonly string[] | null>(null)
    expect(collapseSplit(unsplit)).toBeNull()
    expect(isTabSplit(null)).toBe(false)
    expect(isTabSplit(unsplit)).toBe(false)
    const split = splitActive(unsplit, "row", ["/bin/zsh"]) // leaf-1 | leaf-2
    expect(collapseSplit(split)).toBe(split) // still split → keep the tree
    expect(isTabSplit(split)).toBe(true)
    // Close the shell leaf → back to the pristine engine → fold to null.
    const shellClosed = removeLeaf(split, "leaf-2")
    expect(shellClosed).not.toBeNull()
    if (shellClosed) expect(collapseSplit(shellClosed)).toBeNull()
    // Close the ENGINE leaf → the sole shell survivor keeps the tree, and
    // tab-level ctrl+w / F2 apply again (not split anymore).
    const engineClosed = removeLeaf(split, "leaf-1")
    expect(engineClosed).not.toBeNull()
    if (engineClosed) {
      expect(collapseSplit(engineClosed)).toBe(engineClosed)
      expect(isTabSplit(engineClosed)).toBe(false)
    }
  })
})
