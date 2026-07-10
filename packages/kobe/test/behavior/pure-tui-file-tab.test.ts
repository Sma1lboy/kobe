/**
 * Regression (2026-07-10): opening files from the pure-TUI FileTree uses
 * one reusable File tab. The old transition appended one command tab for
 * every file, so browsing a few files permanently grew the tab strip.
 */

import { describe, expect, test } from "vitest"
import { initialTabs, openEditorTab } from "../../src/tui/workspace/terminal-tabs-core"

describe("pure-TUI File tab behavior", () => {
  test("opening another file replaces and focuses the existing File tab", () => {
    let tabs = initialTabs()
    const openFile = (path: string): void => {
      tabs = openEditorTab(tabs, ["nvim", path], path)
    }

    openFile("src/a.ts")
    const fileTabId = tabs.activeId
    openFile("src/b.ts")

    expect(tabs.tabs).toHaveLength(2)
    expect(tabs.activeId).toBe(fileTabId)
    expect(tabs.tabs.find((tab) => tab.id === fileTabId)).toMatchObject({
      kind: "command",
      purpose: "editor",
      title: "src/b.ts",
      command: ["nvim", "src/b.ts"],
    })
  })
})
