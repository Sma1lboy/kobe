/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

export function InboxUnavailableDialog(props: { title: string; message: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()

  useBindings(() => ({ bindings: [{ key: "return", cmd: () => dialog.clear() }] }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>{props.message}</text>
      <box flexDirection="row" justifyContent="flex-end" paddingTop={1}>
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>OK</text>
        </box>
      </box>
    </box>
  )
}

InboxUnavailableDialog.show = (dialog: DialogContext, title: string, message: string): void => {
  dialog.replace(() => <InboxUnavailableDialog title={title} message={message} />)
  dialog.setSize("small")
}
