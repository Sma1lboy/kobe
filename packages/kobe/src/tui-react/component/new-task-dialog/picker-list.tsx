/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import type { ReactNode } from "react"
import type { Field, PickerWindow } from "../../../tui/component/new-task-dialog/state"
import { type Theme, useTheme } from "../../context/theme"
import { useT } from "../../i18n"

export type PickerRow = {
  readonly key: string
  readonly body: string
  readonly accent?: boolean
}

export function PickerList(props: {
  window: PickerWindow
  cursor: number
  rows: readonly PickerRow[]
  onPick: (absoluteIndex: number) => void
  footer?: ReactNode
  paddingBottom?: number
}) {
  const { theme } = useTheme()
  const t = useT()
  const below = props.window.total - props.window.start - props.window.items.length
  return (
    <box gap={0} paddingLeft={2} paddingBottom={props.paddingBottom}>
      {props.window.start > 0 ? (
        <text fg={theme.textMuted} wrapMode="none">
          {t("newTask.picker.moreAbove", { count: props.window.start })}
        </text>
      ) : null}
      {props.rows.map((row, i) => {
        const absoluteIndex = props.window.start + i
        const isCursor = absoluteIndex === props.cursor
        return (
          <text
            key={row.key}
            fg={isCursor ? theme.primary : row.accent ? theme.accent : theme.textMuted}
            attributes={isCursor ? TextAttributes.BOLD : undefined}
            wrapMode="none"
            onMouseUp={() => props.onPick(absoluteIndex)}
          >
            {isCursor ? "▸ " : "  "}
            {row.body}
          </text>
        )
      })}
      {below > 0 ? (
        <text fg={theme.textMuted} wrapMode="none">
          {t("newTask.picker.moreBelow", { count: below })}
        </text>
      ) : null}
      {props.footer}
    </box>
  )
}

export function labelStyle(theme: Theme, focusedField: Field, f: Field): { fg: Theme["primary"]; attributes?: number } {
  return focusedField === f
    ? { fg: theme.primary, attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE }
    : { fg: theme.textMuted }
}
