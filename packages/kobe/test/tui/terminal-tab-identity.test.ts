/**
 * `demoteExitedEngine` — a tab is a SHELL; the engine is a process in it.
 *
 * The bug this pins (owner report 2026-08-10): a tab you exited claude in
 * kept `kind: "engine"`, so the sidebar row kept its agent state dot and
 * every keystroke marked an optimistic turn — while the row's own label had
 * already fallen back to `shell N`. Resetting the state at the exit is what
 * makes label, glyph and activity agree without a per-consumer guard.
 */

import { describe, expect, it } from "vitest"
import { demoteExitedEngine } from "../../src/tui/workspace/terminal-tab-identity"
import type { TerminalTab } from "../../src/tui/workspace/terminal-tabs-core"

const SHELL = ["/bin/zsh"]
const engineTab = (over: Partial<TerminalTab> = {}): TerminalTab =>
  ({ kind: "engine", id: "tab-1", title: null, ordinal: 1, sessionId: "s1", spawned: true, ...over }) as TerminalTab

describe("demoteExitedEngine", () => {
  it("resets an exited engine tab to a shell — kind, session pin and status title", () => {
    const out = demoteExitedEngine(engineTab({ lastTitle: "⠐ 利用自进化…" }), "claude", null, SHELL)
    expect(out.kind).toBe("command")
    expect(out).toMatchObject({ command: SHELL, lastTitle: null, liveVendor: null })
    expect("sessionId" in out).toBe(false)
  })

  it("keeps what belongs to the TAB, not the engine", () => {
    const out = demoteExitedEngine(
      engineTab({ title: "my tab", ordinal: 7, autoTitle: "first prompt" }),
      "claude",
      null,
      SHELL,
    )
    expect(out).toMatchObject({ title: "my tab", ordinal: 7, autoTitle: "first prompt", id: "tab-1" })
  })

  it("does not fire during the spawn window — no engine seen yet is not an exit", () => {
    const tab = engineTab()
    expect(demoteExitedEngine(tab, undefined, null, SHELL)).toBe(tab)
    expect(demoteExitedEngine(tab, null, null, SHELL)).toBe(tab)
  })

  it("leaves a live engine, an unprobed tab, and a plain shell alone", () => {
    const live = engineTab()
    expect(demoteExitedEngine(live, "claude", "claude", SHELL)).toBe(live)
    expect(demoteExitedEngine(live, "claude", undefined, SHELL)).toBe(live)
    const shell = { kind: "command", id: "tab-2", title: null, ordinal: 2, command: SHELL } as TerminalTab
    expect(demoteExitedEngine(shell, "claude", null, SHELL)).toBe(shell)
  })

  it("never demotes a viewport tab — it only VIEWS another task's session", () => {
    const viewport = engineTab({ ptyTask: { id: "other", worktree: "/w" } })
    expect(demoteExitedEngine(viewport, "claude", null, SHELL)).toBe(viewport)
  })
})
