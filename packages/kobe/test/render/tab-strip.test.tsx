/** @jsxImportSource @opentui/react */
/**
 * Terminal-tab title/status ownership. Interactive engines that publish
 * their own activity in the live OSC title must not get a second kobe
 * turn glyph prefixed to the same tab.
 */

import { describe, expect, it } from "bun:test"
import type { ChatTabTurnState } from "../../src/engine/turn-detector"
import { TabStrip } from "../../src/tui-react/workspace/tab-strip"
import type { TerminalTab } from "../../src/tui/workspace/terminal-tabs-core"
import { type RenderHandle, act, renderComponent } from "./harness"

const codexTab: TerminalTab = {
  kind: "engine",
  id: "tab-26",
  title: null,
  ordinal: 26,
  vendor: "codex",
}

describe("TabStrip native terminal-title status", () => {
  it("renders Codex's native activity/thread title without a duplicate kobe glyph", async () => {
    let handle: RenderHandle | undefined
    await act(async () => {
      handle = await renderComponent(
        <TabStrip
          tabs={[codexTab]}
          activeId={codexTab.id}
          turnStates={new Map<string, ChatTabTurnState>([[codexTab.id, "running"]])}
          onSelect={() => {}}
          vendor="codex"
          liveTitles={new Map([[codexTab.id, "⠇ fix codex tab naming"]])}
        />,
        { width: 80, height: 3 },
      )
    })
    if (!handle) throw new Error("mount failed")
    const mounted = handle

    let text = ""
    await act(async () => {
      text = await mounted.frame()
    })
    expect(text).toContain("⠇ fix codex tab naming 26")
    expect(text).not.toContain("●")
    await act(async () => mounted.destroy())
  })

  it("keeps kobe's status fallback until the engine has emitted a native title", async () => {
    let handle: RenderHandle | undefined
    await act(async () => {
      handle = await renderComponent(
        <TabStrip
          tabs={[codexTab]}
          activeId={codexTab.id}
          turnStates={new Map<string, ChatTabTurnState>([[codexTab.id, "running"]])}
          onSelect={() => {}}
          vendor="codex"
          liveTitles={new Map()}
        />,
        { width: 80, height: 3 },
      )
    })
    if (!handle) throw new Error("mount failed")
    const mounted = handle

    let text = ""
    await act(async () => {
      text = await mounted.frame()
    })
    expect(text).toContain("● codex 26")
    await act(async () => mounted.destroy())
  })
})
