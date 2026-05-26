/**
 * Single-field rename dialog. Used by the sidebar `r` chord (rename
 * task) and the chat-tab right-click / rename action (rename chat tab),
 * dispatched via the `dialogTitle` prop to relabel the header.
 *
 * The current title is pre-filled in the input so the user can edit
 * in place. Enter commits, esc cancels (handled by the dialog stack).
 *
 * Trim + empty-string guard: `enter` on an empty/whitespace-only value
 * is a no-op (we don't dismiss, so the user notices nothing happened
 * and can either type something or hit esc). The orchestrator's
 * `setTitle` / `setTabTitle` defend in depth.
 *
 * `stripNewlines` is shared with the new-task dialog — opentui's
 * `<input>` quirk that inserts a literal `\n` on Enter. Imported from
 * `../new-task-dialog/index` so the two dialogs share a single
 * sanitiser.
 */

import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { stripNewlines } from "../new-task-dialog"

export function RenameTaskDialogView(props: {
  currentTitle: string
  dialogTitle?: string
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
          {props.dialogTitle ?? "Rename task"}
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
