import { describe, expect, it } from "vitest"
import { codexSessionIdFromTitle, isCodexPlaceholderTitle } from "../../src/engine/codex-local/terminal-title.ts"
import { tabTitle, tabTitleStable } from "../../src/tui/workspace/terminal-tab-split"
import type { TerminalTab } from "../../src/tui/workspace/terminal-tabs-core"

/**
 * Codex titles an UNNAMED thread with its own session UUID, so a codex
 * tab's live OSC title was an identifier, not a name — and it outranked
 * the first-prompt autoTitle. The engine-owned `isPlaceholderTitle`
 * judgement makes such titles win no naming rung.
 */
const engineTab = (over: Partial<TerminalTab> = {}): TerminalTab =>
  ({ kind: "engine", id: "tab-1", title: null, ordinal: 1, vendor: "codex", ...over }) as TerminalTab

const THREAD_ID = "019b8f2e-3a4b-7c1d-8e2f-0a1b2c3d4e5f"

describe("engine placeholder titles (codex unnamed thread = session UUID)", () => {
  it("isCodexPlaceholderTitle matches a bare UUID only", () => {
    expect(isCodexPlaceholderTitle(THREAD_ID)).toBe(true)
    expect(isCodexPlaceholderTitle("fix the login form")).toBe(false)
    expect(isCodexPlaceholderTitle("019b8f2e")).toBe(false)
  })

  it("a bare re-run codex titles itself after the project dir — a placeholder WITH worktree context", () => {
    const ctx = { worktree: "/home/u/repo/repo-abc123/crane" }
    expect(isCodexPlaceholderTitle("crane", ctx)).toBe(true)
    // A thread genuinely /rename'd to something else is a real name.
    expect(isCodexPlaceholderTitle("fix the login form", ctx)).toBe(false)
    // Without the worktree the judgement stays shape-only (no false positive).
    expect(isCodexPlaceholderTitle("crane")).toBe(false)
  })

  it("a live placeholder title falls through to the first-prompt autoTitle", () => {
    const tab = engineTab({ autoTitle: "add a login form" })
    expect(tabTitle(tab, "codex", THREAD_ID)).toBe("add a login form")
  })

  it("a recorded placeholder title falls through too (Inbox / tree surfaces)", () => {
    const tab = engineTab({ autoTitle: "add a login form", lastTitle: THREAD_ID })
    expect(tabTitle(tab, "codex")).toBe("add a login form")
  })

  it("with no autoTitle a placeholder falls to the vendor default, not the UUID", () => {
    expect(tabTitle(engineTab(), "codex", THREAD_ID)).toBe("codex 1")
  })

  it("a real thread name (after /rename) still wins over the autoTitle", () => {
    const tab = engineTab({ autoTitle: "add a login form" })
    expect(tabTitle(tab, "codex", "refactor the parser")).toBe("refactor the parser 1")
  })

  it("the tree surface (tabTitleStable) applies the same fall-through", () => {
    const tab = engineTab({ autoTitle: "add a login form", lastTitle: THREAD_ID, liveVendor: "codex" })
    expect(tabTitleStable(tab, "codex")).toBe("add a login form")
  })

  it("a manual rename still outranks everything", () => {
    const tab = engineTab({ title: "my tab", autoTitle: "add a login form" })
    expect(tabTitle(tab, "codex", THREAD_ID)).toBe("my tab")
  })

  it("the judgement is engine-owned: a claude tab keeps a UUID-shaped live title", () => {
    const tab = engineTab({ vendor: "claude", autoTitle: "add a login form" })
    expect(tabTitle(tab, "claude", THREAD_ID)).toBe(`${THREAD_ID} 1`)
  })

  it("a project-name live title (user re-ran bare `codex` in the tab) falls through given the worktree", () => {
    const tab = engineTab({ autoTitle: "add a login form" })
    expect(tabTitle(tab, "codex", "crane", { worktree: "/x/repo-abc123/crane" })).toBe("add a login form")
    // Same title, no worktree context → no judgement, the live title stands.
    expect(tabTitle(tab, "codex", "crane")).toBe("crane 1")
  })

  it("a shell tab running a user-typed codex is judged by the LIVE vendor from ctx", () => {
    const shellTab = {
      kind: "command",
      id: "tab-1",
      title: null,
      ordinal: 1,
      autoTitle: "add a login form",
    } as TerminalTab
    // No ctx.vendor: a command tab has no pinned engine, nothing to judge with.
    expect(tabTitle(shellTab, "codex", "crane", { worktree: "/x/repo-abc123/crane" })).toBe("crane 1")
    // The strip's probe resolved codex → codex's placeholder shapes apply.
    expect(tabTitle(shellTab, "codex", "crane", { vendor: "codex", worktree: "/x/repo-abc123/crane" })).toBe(
      "add a login form",
    )
  })

  it("the tree surface falls through on a project-name live title too", () => {
    const tab = engineTab({ autoTitle: "add a login form", lastTitle: "crane", liveVendor: "codex" })
    expect(tabTitleStable(tab, "codex", "codex", "crane", "/x/repo-abc123/crane")).toBe("add a login form")
  })

  it("codexSessionIdFromTitle reads the running session's id out of the title (session-switch follow)", () => {
    expect(codexSessionIdFromTitle(THREAD_ID)).toBe(THREAD_ID)
    expect(codexSessionIdFromTitle(`  ${THREAD_ID} `)).toBe(THREAD_ID)
    // A named thread (or a bare re-run's project name) carries no identity.
    expect(codexSessionIdFromTitle("refactor the parser")).toBeNull()
    expect(codexSessionIdFromTitle("crane")).toBeNull()
    expect(codexSessionIdFromTitle("019b8f2e")).toBeNull()
  })
})
