/**
 * Single-field rename dialog (v0.6).
 *
 * Used by the sidebar `r` chord. Pre-fills the current title; `enter`
 * commits, `esc` cancels (handled by the dialog stack).
 */

import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { type DialogContext, useDialog } from "../ui/dialog"
import { stripNewlines } from "./dialog-utils"

export function RenameTaskDialogView(props: {
  currentTitle: string
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [title, setTitle] = createSignal(props.currentTitle)

  function commit() {
    const t = title().trim()
    if (!t) return
    props.onSubmit(t)
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Rename task
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>title</text>
        <input
          value={title()}
          placeholder={props.currentTitle}
          focused={true}
          onInput={(v: string) => setTitle(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>enter rename · esc cancel</text>
      </box>
    </box>
  )
}

export const RenameTaskDialog = {
  show(dialog: DialogContext, currentTitle: string): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      dialog.replace(
        () => (
          <RenameTaskDialogView
            currentTitle={currentTitle}
            onSubmit={(t) => resolve(t)}
            onCancel={() => resolve(undefined)}
          />
        ),
        () => resolve(undefined),
      )
      dialog.setSize("small")
    })
  },
}
