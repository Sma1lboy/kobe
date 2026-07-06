import { t } from "@/tui/i18n"
import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { isBlankText, stripNewlines } from "../new-task-dialog"

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
  const [value, setValue] = createSignal(props.currentTitle)

  function commit() {
    const v = value().trim()
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
          value={value()}
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
