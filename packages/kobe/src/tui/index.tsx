/**
 * kobe TUI bootstrap.
 *
 * Thin entry point — delegates immediately to `app.tsx`, which owns the
 * full 5-pane layout, orchestrator wiring, and keybindings.
 *
 * The `Banner`/`Shell`/`App` functions below are Phase 0 scaffolding kept
 * per the no-deletion rule but are never mounted. `startTui` calls
 * `startApp` directly.
 */

import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import type { TuiDaemonMode } from "../daemon/mode.ts"
import { startApp } from "./app"
import { HelpDialog } from "./component/help-dialog"
import { Sidebar } from "./component/sidebar"
import { CommandPaletteProvider } from "./context/command-palette"
import { useKobeKeybindings } from "./context/keybindings"
import { KVProvider } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, useTheme } from "./context/theme"
import { DialogProvider, useDialog } from "./ui/dialog"

/** Dead — kept with the unused Banner/Shell below. Real default is in app.tsx. */
const DEFAULT_THEME = "tokyonight"

const KOBE_BANNER = ["k o b e", "─────────"]

function HelpHint() {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={2} paddingTop={1}>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>?</span> help
      </text>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>cmd+k</span> commands
      </text>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>q</span> quit
      </text>
    </box>
  )
}

function Banner() {
  const { theme, selected } = useTheme()
  return (
    <box flexGrow={1} paddingLeft={4} paddingTop={2} paddingRight={4} paddingBottom={1}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        {KOBE_BANNER[0]}
      </text>
      <text fg={theme.borderActive}>{KOBE_BANNER[1]}</text>
      <box paddingTop={1}>
        <text fg={theme.text}>kobe — TUI orchestrator for Claude Code</text>
        <text fg={theme.textMuted}>
          theme: <span style={{ fg: theme.accent }}>{selected}</span>
        </text>
      </box>
      <HelpHint />
    </box>
  )
}

function Shell() {
  const { theme } = useTheme()
  const dialog = useDialog()

  // Mount global keybindings near the root. Pane-local bindings register
  // their own scoped useBindings calls deeper in the tree.
  useKobeKeybindings({
    onShowHelp: () => HelpDialog.show(dialog),
  })

  return (
    <box flexDirection="row" flexGrow={1}>
      <Sidebar
        title="kobe"
        emptyMessage="No tasks yet."
        footer={
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> ready
          </text>
        }
      />
      <Banner />
    </box>
  )
}

function App() {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <KVProvider>
        <SyncProvider>
          <DialogProvider>
            <CommandPaletteProvider>
              <Show when={true}>
                <Shell />
              </Show>
            </CommandPaletteProvider>
          </DialogProvider>
        </SyncProvider>
      </KVProvider>
    </ThemeProvider>
  )
}

export async function startTui(options: { daemonMode?: TuiDaemonMode } = {}): Promise<void> {
  // Stream E: delegate to the new App that wires Orchestrator + panes.
  // The Banner/Shell pair above is kept for the historical commit log
  // but is no longer mounted.
  void Banner
  void App
  await startApp(options)
}
