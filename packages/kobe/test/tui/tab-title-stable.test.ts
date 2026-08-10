/**
 * `tabTitleStable` — the sidebar tree's naming rule.
 *
 * The tree shows kobe's OWN state glyph (daemon activity) beside each tab, and
 * renders tabs it does not host, so it has no live title stream. Plain
 * `tabTitle` therefore fell back to `lastTitle`, which for a status-owning
 * engine IS its self-reported status: a row sat wearing a frozen `⠐ 利用自进化…`
 * spinner phrase that contradicted the glyph next to it.
 */

import { describe, expect, it } from "vitest"
import { tabTitle, tabTitleStable } from "../../src/tui/workspace/terminal-tab-split"
import type { TerminalTab } from "../../src/tui/workspace/terminal-tabs-core"

const engineTab = (over: Partial<TerminalTab> = {}): TerminalTab =>
  ({ kind: "engine", id: "tab-1", title: null, ordinal: 1, ...over }) as TerminalTab

describe("tabTitleStable", () => {
  it("drops a status-owning engine's recorded status line", () => {
    const tab = engineTab({ lastTitle: "⠐ 利用自进化代理迭代 kobe", autoTitle: "wire up the digest verb" })
    // What the tree used to show, and what it shows now.
    expect(tabTitle(tab, "claude")).toContain("利用自进化")
    expect(tabTitleStable(tab, "claude")).toBe("wire up the digest verb")
  })

  it("falls back to the vendor default when there is nothing stabler", () => {
    expect(tabTitleStable(engineTab({ lastTitle: "⠹ thinking…" }), "claude")).toBe("claude 1")
  })

  it("keeps a manual rename — that is the user's name, not the engine's", () => {
    const tab = engineTab({ title: "my tab", lastTitle: "⠐ working" })
    expect(tabTitleStable(tab, "claude")).toBe("my tab")
  })

  it("leaves engines that do not own their title alone (a real process name)", () => {
    // copilot declares no `terminalTitle.ownsStatus`, so its OSC title is an
    // ordinary process name and makes a perfectly good label — unlike claude
    // and codex, which both put live activity in theirs.
    const tab = engineTab({ lastTitle: "copilot-run", vendor: "copilot" })
    expect(tabTitleStable(tab, "copilot")).toBe(tabTitle(tab, "copilot"))
    expect(tabTitleStable(tab, "copilot")).toContain("copilot-run")
  })

  it("also strips codex's status title — it owns its title too", () => {
    const tab = engineTab({ lastTitle: "Working ▌ my thread", vendor: "codex", autoTitle: "add the ruler" })
    expect(tabTitleStable(tab, "codex")).toBe("add the ruler")
  })

  it("uses the LIVE vendor when a shell tab is running an engine", () => {
    // A user-typed `claude` in a shell tab: kind is "command", but the live
    // probe says claude, so its status title must be dropped too.
    const tab = { kind: "command", id: "tab-2", title: null, ordinal: 2, lastTitle: "⠐ 思考中" } as TerminalTab
    expect(tabTitleStable(tab, "claude", "claude")).not.toContain("思考中")
  })

  it("keeps a non-engine tab's process name when nothing claims status", () => {
    const tab = { kind: "command", id: "tab-3", title: null, ordinal: 3, lastTitle: "vim" } as TerminalTab
    expect(tabTitleStable(tab, "claude")).toBe("vim 3")
  })

  it("a confirmed-dead engine tab is a shell — no pin, no frozen status", () => {
    // Tab spawned as codex, engine ctrl+C'd: the probe CONFIRMS no engine
    // (liveVendor === null). Neither "codex N" nor the stale status may name
    // it; the first-prompt summary (if any) still beats the bare default.
    const tab = engineTab({ vendor: "codex", lastTitle: "Working ▌ my thread", autoTitle: "add the ruler" })
    expect(tabTitleStable(tab, "codex", null)).toBe("add the ruler")
    const bare = engineTab({ vendor: "codex", lastTitle: "Working ▌ my thread" })
    expect(tabTitleStable(bare, "codex", null)).toBe("shell 1")
  })

  it("the LIVE vendor renames a tab pinned to another engine", () => {
    // Spawned as codex, now running claude: the pin is history.
    const tab = engineTab({ vendor: "codex", lastTitle: "⠐ thinking" })
    expect(tabTitleStable(tab, "codex", "claude")).toBe("claude 1")
  })

  it("undefined liveVendor (probe can't look) keeps the engine pin", () => {
    const tab = engineTab({ vendor: "codex", lastTitle: "Working ▌ t" })
    expect(tabTitleStable(tab, "codex")).toBe("codex 1")
  })
})
