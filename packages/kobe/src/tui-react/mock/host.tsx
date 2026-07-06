/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { PANE_ORDER, useFocus } from "../context/focus"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { Dialog, useDialog } from "../ui/dialog"

function DemoDialog() {
  const { theme } = useTheme()
  const dialog = useDialog()
  return (
    <Dialog size="small" onClose={() => dialog.clear()}>
      <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text} wrapMode="word">
          React dialog stack works — esc closes.
        </text>
      </box>
    </Dialog>
  )
}

function Workbench() {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const focus = useFocus()
  const dialog = useDialog()

  useBindings(() => ({
    enabled: true,
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
      { key: "tab", cmd: () => focus.cycle(1) },
      { key: "d", cmd: () => dialog.replace(() => <DemoDialog />) },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          REACT
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          kobe infra pilot
        </text>
        <box flexGrow={1} />
        <text fg={theme.textMuted} wrapMode="none">
          q quit · tab focus · d dialog
        </text>
      </box>
      <box paddingLeft={1} paddingRight={1} paddingTop={1} flexDirection="column" flexGrow={1}>
        <text fg={theme.text} wrapMode="word">
          {}
          {t("settings.title")} — theme "{themeCtx.selected}", focused pane: {focus.focused}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          panes: {PANE_ORDER.map((p) => (p === focus.focused ? `[${p}]` : p)).join(" ")}
        </text>
      </box>
    </box>
  )
}

await bootPaneHost({
  setup: () => ({ root: () => <Workbench /> }),
})
