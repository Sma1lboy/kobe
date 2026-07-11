/** @jsxImportSource @opentui/react */
/**
 * Terminal-tab title/status ownership. Interactive engines that publish
 * their own activity in the live OSC title must not get a second kobe
 * turn glyph prefixed to the same tab — regardless of whether kobe
 * launched the engine or the user typed it into a shell (the identity
 * comes from `turnVendors`, not the tab's kind).
 */

import { describe, expect, it } from "bun:test"
import type { ChatTabTurnState } from "../../src/engine/turn-detector"
import { TabStrip } from "../../src/tui-react/workspace/tab-strip"
import type { TerminalTab } from "../../src/tui/workspace/terminal-tabs-core"
import type { VendorId } from "../../src/types/vendor"
import { type RenderHandle, act, renderComponent } from "./harness"

const codexTab: TerminalTab = {
  kind: "engine",
  id: "tab-26",
  title: null,
  ordinal: 26,
  vendor: "codex",
}

/** A plain shell tab where the USER typed an engine (no pinned vendor). */
const shellTab: TerminalTab = {
  kind: "command",
  id: "tab-9",
  title: null,
  ordinal: 9,
  command: ["zsh"],
}

async function renderStrip(props: {
  tab: TerminalTab
  turnStates: ReadonlyMap<string, ChatTabTurnState>
  liveTitles: ReadonlyMap<string, string>
  turnVendors: ReadonlyMap<string, VendorId>
  vendor: VendorId
}): Promise<{ text: string; destroy: () => Promise<void> }> {
  let handle: RenderHandle | undefined
  await act(async () => {
    handle = await renderComponent(
      <TabStrip
        tabs={[props.tab]}
        activeId={props.tab.id}
        turnStates={props.turnStates}
        onSelect={() => {}}
        vendor={props.vendor}
        liveTitles={props.liveTitles}
        turnVendors={props.turnVendors}
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
  return {
    text,
    destroy: async () => {
      await act(async () => mounted.destroy())
    },
  }
}

describe("TabStrip native terminal-title status", () => {
  it("renders Codex's native activity/thread title without a duplicate kobe glyph", async () => {
    const { text, destroy } = await renderStrip({
      tab: codexTab,
      turnStates: new Map([[codexTab.id, "running"]]),
      liveTitles: new Map([[codexTab.id, "⠇ fix codex tab naming"]]),
      turnVendors: new Map([[codexTab.id, "codex"]]),
      vendor: "codex",
    })
    expect(text).toContain("⠇ fix codex tab naming 26")
    expect(text).not.toContain("●")
    await destroy()
  })

  it("keeps kobe's status fallback until the engine has emitted a native title", async () => {
    const { text, destroy } = await renderStrip({
      tab: codexTab,
      turnStates: new Map([[codexTab.id, "running"]]),
      liveTitles: new Map(),
      turnVendors: new Map([[codexTab.id, "codex"]]),
      vendor: "codex",
    })
    expect(text).toContain("● codex 26")
    await destroy()
  })

  it("treats a user-typed engine in a shell tab exactly like a kobe-launched one", async () => {
    const { text, destroy } = await renderStrip({
      tab: shellTab,
      turnStates: new Map([[shellTab.id, "running"]]),
      liveTitles: new Map([[shellTab.id, "claude"]]),
      turnVendors: new Map([[shellTab.id, "claude"]]),
      vendor: "claude",
    })
    expect(text).toContain("claude 9")
    expect(text).not.toContain("●")
    await destroy()
  })

  it("keeps the glyph when a rename hides the native title", async () => {
    const renamed: TerminalTab = { ...shellTab, title: "my session" }
    const { text, destroy } = await renderStrip({
      tab: renamed,
      turnStates: new Map([[renamed.id, "running"]]),
      liveTitles: new Map([[renamed.id, "claude"]]),
      turnVendors: new Map([[renamed.id, "claude"]]),
      vendor: "claude",
    })
    expect(text).toContain("● my session")
    await destroy()
  })

  it("shows no idle-circle placeholder for a freshly-spawned engine tab before its first poll", async () => {
    // turnStates empty = detector hasn't reported yet. A kobe-launched
    // engine tab must NOT fall back to the hollow "○" idle glyph in this
    // window — we already know it's an engine, the placeholder is noise.
    const { text, destroy } = await renderStrip({
      tab: codexTab,
      turnStates: new Map(),
      liveTitles: new Map(),
      turnVendors: new Map(),
      vendor: "codex",
    })
    expect(text).not.toContain("○")
    expect(text).toContain("codex 26")
    await destroy()
  })
})
