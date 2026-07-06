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
 * light up the Dev section's "Restart backend" action. The connect is
 * NON-spawning (`connectIfRunning`, same contract as the Tasks pane): a
 * settings window opened from a detached tmux session (the user quit kobe,
 * the daemon idle-stopped, the session persists) must NEVER boot a daemon —
 * doing so would leave a gui-less daemon that never idle-stops, breaking
 * the refcounted lazy-shutdown. With no daemon up, "Restart backend" is
 * simply disabled (it has nothing to restart); the page degrades the same
 * way it already does when the daemon is unreachable.
 */

import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { SettingsDialog } from "../component/settings-dialog"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { currentSessionName, refreshKobeWorkspacePanes } from "../panes/terminal/tmux"
import { useDialog } from "../ui/dialog"

function SettingsPage(props: { orchestrator: RemoteOrchestrator | null }) {
  const kv = useKV()
  const dialog = useDialog()
  const { theme } = useTheme()
  let visualPrefsChanged = false
  let exiting = false

  // Visual prefs (theme / transparent / focus accent) are applied
  // centrally — boot + live `ui-prefs` pushes — by host-boot's
  // UiPrefsSync; this page no longer re-applies them itself.

  async function exit(): Promise<void> {
    if (exiting) return
    exiting = true
    try {
      const flushed = kv.flush()
      if (flushed && visualPrefsChanged) {
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
    // Scroll, don't compress. The full-window page has no fixed-height card
    // like the overlay's Dialog, so when the section content is taller than
    // the tmux window Yoga shrinks the flex rows and they overlap into an
    // unreadable jumble. A scrollbox gives the content its natural height
    // and scrolls the overflow instead, so every section row stays legible.
    <scrollbox
      flexGrow={1}
      backgroundColor={theme.background}
      paddingTop={1}
      verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
    >
      <SettingsDialog
        kv={kv}
        orchestrator={props.orchestrator ?? undefined}
        standalone={true}
        onVisualPrefsChange={() => {
          visualPrefsChanged = true
        }}
        onClose={exit}
      />
    </scrollbox>
  )
}

export async function startSettingsHost(): Promise<void> {
  await bootPaneHost({
    setup: async () => {
      let orch: RemoteOrchestrator | null = null
      try {
        // NON-spawning: connect ONLY to a daemon that's already running. A
        // gui owns daemon lifetime; a settings window must not resurrect an
        // idle-stopped daemon (it would never idle-stop again — no gui holds
        // it). `null` → no daemon up → Restart backend disabled.
        const client = await connectIfRunning()
        if (client) {
          const remote = new RemoteOrchestrator(client)
          await remote.init()
          orch = remote
        } else {
          console.error("[kobe settings] no daemon running; Restart backend disabled")
        }
      } catch (err) {
        console.error("[kobe settings] daemon unavailable; Restart backend disabled:", err)
      }
      return {
        root: () => <SettingsPage orchestrator={orch} />,
        onDestroy: () => {
          orch?.dispose()
        },
      }
    },
  })
}
