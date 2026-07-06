/** @jsxImportSource @opentui/react */
/**
 * Shared windowed picker list + field-label styling for the React
 * new-task dialog (issue #15, G3W2). The Solid shell repeats the
 * "↑ N more / rows / ↓ N more" block four times (repo, branch, clone
 * parent, adopt); the React port renders all four through this one
 * component — callers supply the pre-windowed row bodies and pick
 * handler, the list owns the cursor arrow, bold, and overflow lines.
 */

import { TextAttributes } from "@opentui/core"
import type { ReactNode } from "react"
import type { Field, PickerWindow } from "../../../tui/component/new-task-dialog/state"
import { type Theme, useTheme } from "../../context/theme"
import { useT } from "../../i18n"

/** One visible picker row — body text plus an accent (selected) flag. */
export type PickerRow = {
  readonly key: string
  readonly body: string
  /** Non-cursor rows render accent (selected) instead of muted. */
  readonly accent?: boolean
}

export function PickerList(props: {
  window: PickerWindow
  cursor: number
  /** Pre-windowed rows; same length/order as `window.items`. */
  rows: readonly PickerRow[]
  onPick: (absoluteIndex: number) => void
  /** Extra line under the list (e.g. the adopt "N selected" hint). */
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

/** Focused field labels go primary + bold + underline; others stay muted. */
export function labelStyle(theme: Theme, focusedField: Field, f: Field): { fg: Theme["primary"]; attributes?: number } {
  return focusedField === f
    ? { fg: theme.primary, attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE }
    : { fg: theme.textMuted }
}
