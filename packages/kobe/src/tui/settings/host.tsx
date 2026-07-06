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

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "escape", cmd: exit },
      { key: "q", cmd: exit },
      { key: "ctrl+c", cmd: exit },
    ],
  }))

  return (
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
