/** @jsxImportSource @opentui/react */
/**
 * Real-render coverage for the keyboard-discoverability hints: the
 * status-bar micro-hint (prefix/help, terminal-passthrough aware), the
 * first-use pane hints and their extinguish/fallback behavior, the master
 * toggle, and the onboarding wizard's "Keyboard basics" page.
 */

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useEffect } from "react"
import { PaneKeyHint, StatusKeyHint } from "../../src/tui-react/component/keyboard-hints"
import { useFocus } from "../../src/tui-react/context/focus"
import { useKV } from "../../src/tui-react/context/kv"
import { useBindings } from "../../src/tui-react/lib/keymap"
import { WizardPage } from "../../src/tui-react/onboarding/host"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { useWorkspaceKeybindings } from "../../src/tui-react/workspace/host-keybindings"
import { KEY_HINTS_ENABLED_KEY, PANE_HINT_USED_KEYS } from "../../src/tui/lib/keyboard-hints"
import { act, renderComponent, settle } from "./harness"

const NOOP = (): void => {}

/** Registers the real workspace chord set so reachability has live data. */
function WorkspaceDriver(props: { children?: React.ReactNode }) {
  const focus = useFocus()
  const dialog = useDialog()
  useWorkspaceKeybindings({
    focus,
    dialog,
    settingsOpen: false,
    worktreesOpen: false,
    openWorktrees: NOOP,
    updateOpen: false,
    openUpdate: NOOP,
    kanbanOpen: false,
    openKanban: NOOP,
    filesPaneVisible: true,
    automationsOpen: false,
    openAutomations: NOOP,
    workItemsOpen: false,
    openWorkItems: NOOP,
    searchActive: false,
    selectedId: null,
    openTaskWorktree: NOOP,
    openSettings: NOOP,
    closeSettings: NOOP,
    createTask: NOOP,
    renameBranch: NOOP,
    cycleVendor: NOOP,
    toggleZen: NOOP,
    jumpToNextAttention: NOOP,
    openInbox: NOOP,
    enterMoveMode: NOOP,
    createPR: NOOP,
  })
  return <>{props.children}</>
}

/** Simulates the embedded terminal owning input: focus workspace + an enabled passthrough table. */
function TerminalPassthroughDriver(props: { children?: React.ReactNode }) {
  const focus = useFocus()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once focus seed for the scenario.
  useEffect(() => focus.setFocused("workspace"), [])
  useBindings(() => ({
    enabled: focus.focused === "workspace",
    bindings: [{ key: "a", cmd: NOOP, passthrough: true }],
  }))
  return <>{props.children}</>
}

/** Writes KV keys on mount, then renders children — for persisted-state cases. */
function KvSeed(props: { entries: readonly [string, unknown][]; children?: React.ReactNode }) {
  const kv = useKV()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once KV seed for the scenario.
  useEffect(() => {
    for (const [key, value] of props.entries) kv.set(key, value)
  }, [])
  return <>{props.children}</>
}

function withTempKvHome(): void {
  process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-hints-"))
}

describe("StatusKeyHint", () => {
  it("advertises the live prefix and help chords from the workspace stack", async () => {
    const { frame } = await renderComponent(
      <WorkspaceDriver>
        <StatusKeyHint />
      </WorkspaceDriver>,
      { providers: { focus: true, dialog: true } },
    )
    const text = await frame()
    expect(text).toContain("⌃ A commands")
    expect(text).toContain("F1 help")
  })

  it("swaps the prefix token for the escape hatch inside the terminal", async () => {
    const { frame } = await renderComponent(
      <WorkspaceDriver>
        <TerminalPassthroughDriver>
          <StatusKeyHint />
        </TerminalPassthroughDriver>
      </WorkspaceDriver>,
      { providers: { focus: true, dialog: true } },
    )
    await settle()
    const text = await frame()
    expect(text).toContain("⌃ Q sidebar")
    expect(text).toContain("F1 help")
    expect(text).not.toContain("commands")
  })

  it("renders nothing when the master toggle is off", async () => {
    withTempKvHome()
    const { frame } = await renderComponent(
      <WorkspaceDriver>
        <KvSeed entries={[[KEY_HINTS_ENABLED_KEY, false]]}>
          <StatusKeyHint />
        </KvSeed>
      </WorkspaceDriver>,
      { providers: { focus: true, dialog: true, kv: true } },
    )
    await settle()
    expect((await frame()).trim()).toBe("")
  })
})

describe("PaneKeyHint", () => {
  it("teaches the sidebar's bare keys on first use", async () => {
    const { frame } = await renderComponent(<PaneKeyHint pane="sidebar" />, {})
    const text = await frame()
    expect(text).toContain("j/k move")
    expect(text).toContain("⏎ open")
  })

  it("extinguishes the sidebar hint once its keys were used", async () => {
    withTempKvHome()
    const { frame } = await renderComponent(
      <KvSeed entries={[[PANE_HINT_USED_KEYS.sidebar, true]]}>
        <PaneKeyHint pane="sidebar" />
      </KvSeed>,
      { providers: { kv: true } },
    )
    await settle()
    expect((await frame()).trim()).toBe("")
  })

  it("falls back to the files pane's permanent short set after use", async () => {
    withTempKvHome()
    const { frame } = await renderComponent(
      <KvSeed entries={[[PANE_HINT_USED_KEYS.files, true]]}>
        <PaneKeyHint pane="files" />
      </KvSeed>,
      { providers: { kv: true } },
    )
    await settle()
    const text = await frame()
    expect(text).toContain("⏎ open")
    expect(text).toContain("d diff")
    expect(text).not.toContain("move")
  })
})

describe("onboarding wizard — Keyboard basics", () => {
  it("shows the live-keymap grammar page after the questions", async () => {
    const { frame, mockInput } = await renderComponent(<WizardPage shell={null} onDone={NOOP} />, {
      width: 100,
      height: 24,
    })
    expect(await frame()).toContain("kobe agent skill")
    act(() => mockInput.pressEnter())
    await settle()
    const text = await frame()
    expect(text).toContain("Keyboard basics")
    expect(text).toContain("j/k moves")
    expect(text).toContain("⌃ A opens the command map")
    expect(text).toContain("full live reference")
    expect(text).toContain("enter finish")
  })
})
