/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import { isBlankText, stripNewlines } from "../../tui/component/new-task-dialog/state"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { type DialogContext, useDialog } from "../ui/dialog"

export function RenameTaskDialogView(props: {
  currentTitle: string
  dialogTitle?: string
  fieldLabel?: string
  submitLabel?: string
  placeholder?: string
  allowEmpty?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const [value, setValue] = useState(props.currentTitle)

  function commit(): void {
    const v = value.trim()
    if (isBlankText(v) && !props.allowEmpty) return
    props.onSubmit(v)
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.dialogTitle ?? t("common.rename.defaultTitle")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>{props.fieldLabel ?? t("common.rename.defaultFieldLabel")}</text>
        <input
          value={value}
          placeholder={props.placeholder ?? props.currentTitle}
          focused={true}
          onInput={(v: string) => setValue(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          {t("common.rename.footerHint", { submitLabel: props.submitLabel ?? t("common.rename.defaultSubmitLabel") })}
        </text>
      </box>
    </box>
  )
}

function show(
  dialog: DialogContext,
  currentTitle: string,
  opts: {
    dialogTitle?: string
    fieldLabel?: string
    submitLabel?: string
    placeholder?: string
    allowEmpty?: boolean
  } = {},
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <RenameTaskDialogView
          currentTitle={currentTitle}
          dialogTitle={opts.dialogTitle}
          fieldLabel={opts.fieldLabel}
          submitLabel={opts.submitLabel}
          placeholder={opts.placeholder}
          allowEmpty={opts.allowEmpty}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export const RenameTaskDialog = {
  show,
}
