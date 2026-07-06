/** @jsxImportSource @opentui/react */

import { HelpDialog } from "../component/help-dialog"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"

function HelpPage() {
  const dialog = useDialog()
  const { theme } = useTheme()

  function exit(): void {
    process.exit(0)
  }

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "escape", cmd: exit },
      { key: "q", cmd: exit },
      { key: "f1", cmd: exit },
      { key: "ctrl+c", cmd: exit },
    ],
  }))

  return (
    <box flexGrow={1} backgroundColor={theme.background} paddingTop={1}>
      <HelpDialog onClose={exit} />
    </box>
  )
}

export async function startHelpHost(): Promise<void> {
  await bootPaneHost({
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <HelpPage /> }),
  })
}
