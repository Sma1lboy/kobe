/**
 * `tabTitleStable` — the sidebar tree's naming rule.
 *
 * The tree shows kobe's OWN state glyph (daemon activity) beside each tab and
 * renders tabs it does not host, so it has no live title stream and reads the
 * RECORDED `lastTitle`.
 *
 * That recording used to be the engine's whole status line (`⠐ 利用自进化…`),
 * so the rule threw it away — which left every row reading "claude 1" while
 * the tab strip showed the real conversation title (owner report
 * 2026-08-10). The status prefix is now stripped where the title enters the
 * app, so what is recorded is the NAME and the tree keeps it. Titles recorded
 * before that fix still carry their prefix and are stripped again here, so
 * old snapshots heal on display without a migration.
 */

import { describe, expect, it } from "vitest"
import { tabTitle, tabTitleStable } from "../../src/tui/workspace/terminal-tab-split"
import type { TerminalTab } from "../../src/tui/workspace/terminal-tabs-core"

const engineTab = (over: Partial<TerminalTab> = {}): TerminalTab =>
  ({ kind: "engine", id: "tab-1", title: null, ordinal: 1, ...over }) as TerminalTab

describe("tabTitleStable", () => {
  it("keeps the recorded conversation name", () => {
    const tab = engineTab({ lastTitle: "修复Settings页面输入焦点和前缀键问题", liveVendor: "claude" })
    expect(tabTitleStable(tab, "claude", "claude")).toBe("修复Settings页面输入焦点和前缀键问题 1")
  })

  // Recorded before the entry-point strip shipped: heal it on display rather
  // than migrating the snapshot.
  it("strips a status prefix left in an older recording", () => {
    const tab = engineTab({ lastTitle: "⠂ Herdr多Agent协作技巧分享", liveVendor: "claude" })
    expect(tabTitleStable(tab, "claude", "claude")).toBe("Herdr多Agent协作技巧分享 1")
  })

  it("also heals codex's spinner frame", () => {
    const tab = engineTab({ lastTitle: "⠹ add the ruler", vendor: "codex", liveVendor: "codex" })
    expect(tabTitleStable(tab, "codex", "codex")).toBe("add the ruler 1")
  })

  // A recording that was ONLY decoration is not a name: fall through to the
  // next rung instead of rendering a lone glyph.
  it("falls through when the recording was only decoration", () => {
    expect(tabTitleStable(engineTab({ lastTitle: "✳", liveVendor: "claude" }), "claude", "claude")).toBe("claude 1")
    const withAuto = engineTab({ lastTitle: "✳", autoTitle: "wire up the digest verb", liveVendor: "claude" })
    expect(tabTitleStable(withAuto, "claude", "claude")).toBe("wire up the digest verb")
  })

  // Regression (owner report 2026-08-10): a tab pinned to a user WRAPPER
  // (`claudecpa` — a zsh function that ends up running real claude) is a
  // custom vendor and declares no glyph vocabulary, so its rows kept the
  // prefix. Cleaning is not gated on `ownsStatus` for exactly this reason.
  it("heals a wrapper vendor's title too", () => {
    const tab = engineTab({ id: "tab-2", ordinal: 2, vendor: "claudecpa", lastTitle: "⠂ Herdr多Agent协作技巧分享" })
    expect(tabTitleStable(tab, "claudecpa" as never, "claudecpa" as never)).toBe("Herdr多Agent协作技巧分享 2")
    // ...and when the process walk resolves the REAL engine underneath.
    expect(tabTitleStable(tab, "claude", "claude")).toBe("Herdr多Agent协作技巧分享 2")
  })

  it("keeps a manual rename — that is the user's name, not the engine's", () => {
    const tab = engineTab({ title: "my tab", lastTitle: "⠐ working" })
    expect(tabTitleStable(tab, "claude")).toBe("my tab")
  })

  it("leaves engines that do not own their title alone (a real process name)", () => {
    // copilot declares no `terminalTitle.ownsStatus`, so its OSC title is an
    // ordinary process name and makes a perfectly good label.
    const tab = engineTab({ lastTitle: "copilot-run", vendor: "copilot" })
    expect(tabTitleStable(tab, "copilot")).toBe(tabTitle(tab, "copilot"))
    expect(tabTitleStable(tab, "copilot")).toContain("copilot-run")
  })

  it("keeps a non-engine tab's process name when nothing claims status", () => {
    const tab = { kind: "command", id: "tab-3", title: null, ordinal: 3, lastTitle: "vim" } as TerminalTab
    expect(tabTitleStable(tab, "claude")).toBe("vim 3")
  })

  it("a confirmed-dead engine tab is a shell — no pin, no frozen status", () => {
    // Tab spawned as codex, engine ctrl+C'd: the probe CONFIRMS no engine
    // (liveVendor === null). Neither "codex N" nor the stale status may name
    // it; the first-prompt summary (if any) still beats the bare default.
    const tab = engineTab({ vendor: "codex", lastTitle: "⠹ my thread", autoTitle: "add the ruler" })
    expect(tabTitleStable(tab, "codex", null)).toBe("add the ruler")
    const bare = engineTab({ vendor: "codex", lastTitle: "⠹ my thread" })
    expect(tabTitleStable(bare, "codex", null)).toBe("shell 1")
  })

  it("the LIVE vendor renames a tab pinned to another engine", () => {
    // Spawned as codex, now running claude: the pin is history. The recording
    // was pure decoration, so the resolved vendor names it.
    const tab = engineTab({ vendor: "codex", lastTitle: "⠐" })
    expect(tabTitleStable(tab, "codex", "claude")).toBe("claude 1")
  })

  // Regression (owner report 2026-08-10): quit kobe with `claude` running in
  // a shell tab, restart, and the sidebar row read "shell N" — the rule only
  // carried a resolved vendor through for tabs already born as engine tabs.
  it("names a shell tab after the engine running in it, not 'shell'", () => {
    const tab = {
      kind: "command",
      id: "tab-2",
      title: null,
      ordinal: 2,
      lastTitle: "⠐",
      liveVendor: "claude",
    } as unknown as TerminalTab
    expect(tabTitleStable(tab, "claude", "claude")).toBe("claude 2")
    // With a real recorded name, that name wins.
    const named = { ...tab, lastTitle: "wire up the digest verb" } as TerminalTab
    expect(tabTitleStable(named, "claude", "claude")).toBe("wire up the digest verb 2")
  })

  // Regression (owner report 2026-08-10): clicking into a tab flashed the
  // engine's live status line before settling. The live vendor comes from a
  // ~2s ps walk, so for one render the probe answers `undefined` — without
  // the RECORDED identity the rule dropped to the raw-title branch.
  it("falls back to the RECORDED vendor so the status line never flashes", () => {
    const tab = {
      kind: "command",
      command: ["/bin/zsh"],
      id: "tab-1",
      title: null,
      ordinal: 1,
      lastTitle: "⠐ Refactoring the parser",
      liveVendor: "claude",
    } as unknown as TerminalTab
    expect(tabTitleStable(tab, "claude", undefined)).toBe("Refactoring the parser 1")
  })

  it("undefined liveVendor (probe can't look) keeps the engine pin", () => {
    const tab = engineTab({ vendor: "codex", lastTitle: "⠹" })
    expect(tabTitleStable(tab, "codex")).toBe("codex 1")
  })
})
