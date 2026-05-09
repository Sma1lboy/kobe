/**
 * kobe TUI bootstrap.
 *
 * Wave 2 Stream E: this file used to render a themed banner with a stub
 * sidebar (Foundation 0.2 scaffolding). It now delegates to `app.tsx`,
 * which wires the Orchestrator + Sidebar + chat placeholder for the G2
 * end-to-end demo. The banner shell below (`Banner`, `Shell`) is kept
 * for reference (CLAUDE.md hard rule: no deletion) but is no longer the
 * mount target.
 *
 * Default theme is `tokyonight` — matches agent-deck's Tokyo Night palette
 * (Stream D resolved decision in PLAN.md). Switch via `theme.set("nord")`
 * once a runtime config is wired (Wave 4-ish).
 *
 * Global keybindings (registered by `useKobeKeybindings`):
 *   - `cmd+k` / `ctrl+k` — open the command palette
 *   - `?` — open the help dialog (full bindings table)
 *   - `tab` / `shift+tab` — focus next/prev pane (no-op until Wave 3)
 *   - `q` — confirm-quit
 *   - `esc` — universal close-top-dialog
 *
 * Pane-local bindings (composer, sidebar nav, palette arrows) register
 * themselves inside their components — this file only owns globals.
 */

import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { startApp } from "./app"
import { HelpDialog } from "./component/help-dialog"
import { Sidebar } from "./component/sidebar"
import { CommandPaletteProvider } from "./context/command-palette"
import { useKobeKeybindings } from "./context/keybindings"
import { KVProvider } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, useTheme } from "./context/theme"
import { DialogProvider, useDialog } from "./ui/dialog"

/** Default theme name. Picked at boot; runtime override lands in a later stream. */
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
        emptyMessage="No tasks yet. Wave 2 Stream F will populate this pane."
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

export async function startTui(): Promise<void> {
  // Stream E: delegate to the new App that wires Orchestrator + panes.
  // The Banner/Shell pair above is kept for the historical commit log
  // but is no longer mounted.
  void Banner
  void App
  await startApp()
}
