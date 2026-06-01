/**
 * `kobe settings` — the Settings page rendered as a standalone
 * full-window surface (the default `chattab` settings surface; see
 * `tui/lib/settings-surface.ts`).
 *
 * This is the SAME `SettingsDialog` component the in-pane `taskpanel`
 * surface pushes onto the dialog stack — reused verbatim (reuse the real
 * dialog, don't improvise a parallel one) — only here it fills its own
 * tmux window instead of overlaying the Tasks pane. Opened by
 * `openSettingsTab`, which spawns this as a new window via `kobe
 * settings`; closing Settings (q / esc / Ctrl+C) exits the process, so
 * tmux closes the window and returns to the previous tab.
 *
 * Like the Tasks pane, this runs as its own process inside a tmux
 * window, so it connects to the daemon itself (RemoteOrchestrator) to
 * light up the Dev section's "Restart backend" action.
 */

import { render } from "@opentui/solid"
import { onMount } from "solid-js"
import { connectOrStartDaemon } from "../../client/daemon-process.ts"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { SettingsDialog } from "../component/settings-dialog"
import { FocusProvider } from "../context/focus"
import { KVProvider, useKV } from "../context/kv"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { useBindings } from "../lib/keymap"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { currentSessionName, refreshKobeWorkspacePanes } from "../panes/terminal/tmux"
import { DialogProvider, useDialog } from "../ui/dialog"

const FALLBACK_THEME = "claude"

function SettingsPage(props: {
  orchestrator: RemoteOrchestrator | null
  transparent: boolean
  focusAccent: ReturnType<typeof readPersistedUiPrefs>["focusAccent"]
}) {
  const kv = useKV()
  const dialog = useDialog()
  const themeCtx = useTheme()
  const { theme } = themeCtx
  let visualPrefsChanged = false
  let exiting = false

  onMount(() => {
    themeCtx.setTransparentBackground(props.transparent)
    if (props.focusAccent) themeCtx.setFocusAccent(props.focusAccent)
  })

  async function exit(): Promise<void> {
    if (exiting) return
    exiting = true
    try {
      kv.flush()
      if (visualPrefsChanged) {
        const session = await currentSessionName()
        if (session) await refreshKobeWorkspacePanes(session)
      }
    } catch (err) {
      console.error("[kobe settings] failed to refresh workspace panes:", err)
    } finally {
      process.exit(0)
    }
  }

  // Page-level close keys. In the dialog (`taskpanel`) surface the dialog
  // stack owns esc/Ctrl+C; here there's no enclosing stack, so the page
  // binds them itself — `q` too, since the full-window page is not a text
  // input at rest. Gated on an empty dialog stack so a sub-dialog (e.g.
  // the engine-command editor) keeps esc/typing for itself.
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "escape", cmd: exit },
      { key: "q", cmd: exit },
      { key: "ctrl+c", cmd: exit },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background} paddingTop={1}>
      <SettingsDialog
        kv={kv}
        orchestrator={props.orchestrator ?? undefined}
        onVisualPrefsChange={() => {
          visualPrefsChanged = true
        }}
        onClose={exit}
      />
    </box>
  )
}

export async function startSettingsHost(): Promise<void> {
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const prefs = readPersistedUiPrefs(FALLBACK_THEME)

  let orch: RemoteOrchestrator | null = null
  try {
    const client = await connectOrStartDaemon()
    const remote = new RemoteOrchestrator(client)
    await remote.init()
    orch = remote
  } catch (err) {
    console.error("[kobe settings] daemon unavailable; Restart backend disabled:", err)
  }

  await render(
    () => (
      <ThemeProvider mode="dark" theme={prefs.theme}>
        <KVProvider>
          <FocusProvider initial="sidebar">
            <DialogProvider>
              <SettingsPage orchestrator={orch} transparent={prefs.transparent} focusAccent={prefs.focusAccent} />
            </DialogProvider>
          </FocusProvider>
        </KVProvider>
      </ThemeProvider>
    ),
    {
      backgroundColor: "transparent",
      externalOutputMode: "passthrough",
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      useKittyKeyboard: {},
      onDestroy: () => {
        orch?.dispose()
      },
    },
  )
}
