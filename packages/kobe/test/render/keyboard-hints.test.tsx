/** @jsxImportSource @opentui/react */
/**
 * Real-render coverage for the keyboard-discoverability hints: the
 * status-bar micro-hint (prefix/help, including terminal passthrough), the
 * first-use pane hints and their extinguish/fallback behavior, the master
 * toggle, and the onboarding wizard's "Keyboard basics" page.
 */

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useEffect } from "react"
import type { RemoteOrchestrator } from "../../src/client/remote-orchestrator"
import { createStateCell } from "../../src/lib/external-store"
import { PaneKeyHint, StatusKeyHintBar } from "../../src/tui-react/component/keyboard-hints"
import { PrefixHud } from "../../src/tui-react/component/prefix-hud"
import { useFocus } from "../../src/tui-react/context/focus"
import { useKV } from "../../src/tui-react/context/kv"
import { useBindings } from "../../src/tui-react/lib/keymap"
import { WizardPage } from "../../src/tui-react/onboarding/host"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { WorkspaceFrame } from "../../src/tui-react/workspace/host-footer"
import { useWorkspaceKeybindings } from "../../src/tui-react/workspace/host-keybindings"
import { KEY_HINTS_ENABLED_KEY, PANE_HINT_USED_KEYS } from "../../src/tui/lib/keyboard-hints"
import { resetPrefixState } from "../../src/tui/lib/keymap-dispatch"
import { act, renderComponent, settle } from "./harness"

const NOOP = (): void => {}

/** Minimal orchestrator stand-in — the frame only reads the usage signal. */
function fakeOrchestrator(): RemoteOrchestrator {
  const cell = createStateCell(null)
  return { usageSnapshotSignal: () => cell } as unknown as RemoteOrchestrator
}

/** Find a substring's cell coordinates in a captured char frame. */
function locate(frameText: string, needle: string): { x: number; y: number } {
  const lines = frameText.split("\n")
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]?.indexOf(needle) ?? -1
    if (x >= 0) return { x, y }
  }
  throw new Error(`not on screen: ${needle}`)
}

/** Registers the real workspace chord set so reachability has live data. */
function WorkspaceDriver(props: { children?: React.ReactNode; onToggleZen?: () => void }) {
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
    toggleZen: props.onToggleZen ?? NOOP,
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
    bindings: [{ key: "ctrl+a", cmd: NOOP, passthrough: true }],
  }))
  return <>{props.children}</>
}

const TEST_MODAL_SCOPE = Symbol("test-modal")

/** Registers a modal barrier, the way an open dialog does. */
function ModalBarrierDriver(props: { children?: React.ReactNode }) {
  useBindings(() => ({ modal: true, bindings: [] }), { modalOwner: TEST_MODAL_SCOPE })
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

describe("StatusKeyHintBar", () => {
  it("advertises the live prefix and help chords from the workspace stack", async () => {
    const { frame } = await renderComponent(
      <WorkspaceDriver>
        <StatusKeyHintBar />
      </WorkspaceDriver>,
      { providers: { focus: true, dialog: true } },
    )
    const text = await frame()
    expect(text).toContain("⌃ A commands")
    expect(text).toContain("F1 help")
  })

  it("keeps the prefix command layer visible inside the terminal", async () => {
    const settingsOpened: true[] = []
    const { frame } = await renderComponent(
      <WorkspaceDriver>
        <TerminalPassthroughDriver>
          <StatusKeyHintBar onOpenSettings={() => settingsOpened.push(true)} />
        </TerminalPassthroughDriver>
      </WorkspaceDriver>,
      { providers: { focus: true, dialog: true } },
    )
    await settle()
    const text = await frame()
    expect(text).toContain("⌃ A commands")
    expect(text).toContain("F1 help")
    expect(text).toContain("[settings]")
    expect(text).not.toContain("⌃ Q sidebar")
  })

  it("opens and dispatches the command layer with ctrl+a inside the terminal", async () => {
    let zenToggles = 0
    const { frame, mockInput } = await renderComponent(
      <WorkspaceFrame orchestrator={fakeOrchestrator()} onOpenSettings={NOOP}>
        <WorkspaceDriver onToggleZen={() => zenToggles++}>
          <TerminalPassthroughDriver>
            <PrefixHud left={1} width={24} />
          </TerminalPassthroughDriver>
        </WorkspaceDriver>
      </WorkspaceFrame>,
      { width: 110, height: 30, providers: { focus: true, dialog: true } },
    )
    await settle()

    act(() => mockInput.pressKey("a", { ctrl: true }))
    await settle(300)
    expect(await frame()).toContain("more Kobe commands")

    act(() => mockInput.pressKey("z"))
    await settle()
    expect(zenToggles).toBe(1)
    act(() => resetPrefixState())
  })

  it("hides the whole bar — [settings] included — while a modal owns input", async () => {
    // Barrier OUTERMOST: parent effects commit after children, so its
    // registration lands on top of the stack — the same position an
    // opening dialog's barrier takes in production.
    const { frame } = await renderComponent(
      <ModalBarrierDriver>
        <WorkspaceDriver>
          <StatusKeyHintBar onOpenSettings={NOOP} />
        </WorkspaceDriver>
      </ModalBarrierDriver>,
      { providers: { focus: true, dialog: true } },
    )
    await settle()
    expect((await frame()).trim()).toBe("")
  })

  it("renders nothing when the master toggle is off", async () => {
    withTempKvHome()
    const { frame } = await renderComponent(
      <WorkspaceDriver>
        <KvSeed entries={[[KEY_HINTS_ENABLED_KEY, false]]}>
          <StatusKeyHintBar onOpenSettings={NOOP} />
        </KvSeed>
      </WorkspaceDriver>,
      { providers: { focus: true, dialog: true, kv: true } },
    )
    await settle()
    expect((await frame()).trim()).toBe("")
  })
})

describe("footer hint clicks", () => {
  it("[settings] opens settings from the workspace footer", async () => {
    const settingsOpened: true[] = []
    const { frame, mockMouse } = await renderComponent(
      <WorkspaceFrame orchestrator={fakeOrchestrator()} onOpenSettings={() => settingsOpened.push(true)}>
        <WorkspaceDriver />
      </WorkspaceFrame>,
      { width: 70, height: 10, providers: { focus: true, dialog: true } },
    )
    await settle()
    const spot = locate(await frame(), "[settings]")
    await mockMouse.click(spot.x + 1, spot.y)
    await settle()
    expect(settingsOpened.length).toBe(1)
  })

  it("clicking the help caption opens the F1 reference", async () => {
    const { frame, mockMouse } = await renderComponent(
      <WorkspaceFrame orchestrator={fakeOrchestrator()} onOpenSettings={NOOP}>
        <WorkspaceDriver />
      </WorkspaceFrame>,
      { width: 90, height: 30, providers: { focus: true, dialog: true } },
    )
    await settle()
    const spot = locate(await frame(), "F1 help")
    await mockMouse.click(spot.x + 1, spot.y)
    await settle()
    expect(await frame()).toContain("kobe — keybindings")
  })

  it("clicking the commands caption arms the real prefix and shows the which-key guide", async () => {
    const { frame, mockMouse } = await renderComponent(
      <WorkspaceFrame orchestrator={fakeOrchestrator()} onOpenSettings={NOOP}>
        <WorkspaceDriver />
        <PrefixHud left={1} width={24} />
      </WorkspaceFrame>,
      { width: 110, height: 30, providers: { focus: true, dialog: true } },
    )
    await settle()
    const spot = locate(await frame(), "commands")
    await mockMouse.click(spot.x + 1, spot.y)
    // The guide expands after the learner delay (180ms).
    await settle(300)
    expect(await frame()).toContain("more Kobe commands")
    act(() => resetPrefixState())
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
