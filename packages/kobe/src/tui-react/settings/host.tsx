/** @jsxImportSource @opentui/react */
/**
 * `kobe settings` — React port of `src/tui/settings/host.tsx` (issue #15,
 * G3), behind `KOBE_REACT=1` in `src/cli/commands-tui.ts`. Same contract:
 * the Settings page rendered as a standalone full-window surface, reusing
 * the SAME SettingsDialog component the overlay surface uses, in its own
 * process inside a tmux window. Closing (q / esc / Ctrl+C) flushes kv,
 * refreshes workspace panes when visual prefs changed, and exits.
 *
 * Daemon connect is NON-spawning (`connectIfRunning`): a settings window
 * must never resurrect an idle-stopped daemon (it would never idle-stop
 * again — no gui holds it). With no daemon up, "Restart backend" is simply
 * disabled and the page degrades the same way it already does when the
 * daemon is unreachable.
 */

import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { useRef } from "react"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { currentSessionName, refreshKobeWorkspacePanes } from "../../tui/panes/terminal/tmux"
import { SettingsDialog } from "../component/settings-dialog"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"

export function SettingsPage(props: { orchestrator: RemoteOrchestrator | null }) {
  const kv = useKV()
  const dialog = useDialog()
  const { theme } = useTheme()
  const visualPrefsChanged = useRef(false)
  const exiting = useRef(false)

  // Visual prefs (theme / transparent / focus accent) are applied
  // centrally — boot + live `ui-prefs` pushes — by host-boot's
  // UiPrefsSync; this page no longer re-applies them itself.

  async function exit(): Promise<void> {
    if (exiting.current) return
    exiting.current = true
    try {
      const flushed = kv.flush()
      if (flushed && visualPrefsChanged.current) {
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
      { key: "escape", cmd: () => void exit() },
      { key: "q", cmd: () => void exit() },
      { key: "ctrl+c", cmd: () => void exit() },
    ],
  }))

  return (
    // Scroll, don't compress — same rationale as the Solid page: the
    // full-window page has no fixed-height card, so a scrollbox gives the
    // content its natural height and scrolls the overflow.
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
          visualPrefsChanged.current = true
        }}
        onClose={() => void exit()}
      />
    </scrollbox>
  )
}

export async function startSettingsHost(): Promise<void> {
  await bootPaneHost({
    providers: { kv: true },
    setup: async () => {
      let orch: RemoteOrchestrator | null = null
      try {
        // NON-spawning: connect ONLY to a daemon that's already running.
        // `null` → no daemon up → Restart backend disabled.
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
