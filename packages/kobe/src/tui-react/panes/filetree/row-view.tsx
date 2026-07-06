/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { type StatWidths, statCell, statusToken } from "../../../tui/panes/filetree/pane-core"
import { type Row, truncatePathTail } from "../../../tui/panes/filetree/rows"
import { useTheme } from "../../context/theme"

export type FileTreeRowProps = {
  row: Row
  cursor: boolean
  statWidths: StatWidths
  pathBudget: number
  onActivate: () => void
}

export function FileTreeRowView(props: FileTreeRowProps) {
  const { theme } = useTheme()
  const bar = (
    <text fg={props.cursor ? theme.focusAccent : undefined} wrapMode="none">
      {props.cursor ? "▌" : " "}
    </text>
  )
  const rowBg = props.cursor ? theme.backgroundElement : undefined
  const row = props.row
  if (row.kind === "dir") {
    const indent = "  ".repeat(row.depth)
    return (
      <box flexDirection="row" gap={0} backgroundColor={rowBg} onMouseUp={() => props.onActivate()}>
        {bar}
        <box flexGrow={1} paddingRight={1}>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
            {`${indent}${row.expanded ? "▾" : "▸"} ${row.name}/`}
          </text>
        </box>
      </box>
    )
  }
  if (row.kind === "file") {
    const indent = "  ".repeat(row.depth)
    return (
      <box flexDirection="row" gap={0} backgroundColor={rowBg} onMouseUp={() => props.onActivate()}>
        {bar}
        <box flexGrow={1} paddingRight={1}>
          <text fg={theme.text} wrapMode="none">
            {`${indent}  ${row.name}`}
          </text>
        </box>
      </box>
    )
  }
  const tone = statusToken(row.status)
  const statusColor =
    tone === "success"
      ? theme.success
      : tone === "warning"
        ? theme.warning
        : tone === "error"
          ? theme.error
          : tone === "info"
            ? theme.info
            : theme.textMuted
  return (
    <box flexDirection="row" gap={0} backgroundColor={rowBg} onMouseUp={() => props.onActivate()}>
      {bar}
      <box flexDirection="row" flexGrow={1} gap={1} paddingRight={1}>
        <text fg={statusColor} wrapMode="none">
          {row.status}
        </text>
        <text fg={theme.text} wrapMode="none" flexGrow={1}>
          {truncatePathTail(row.path, props.pathBudget)}
        </text>
        {props.statWidths.added > 0 ? (
          <text fg={theme.success} wrapMode="none">
            {statCell(row.added, props.statWidths.added, "+")}
          </text>
        ) : null}
        {props.statWidths.deleted > 0 ? (
          <text fg={theme.error} wrapMode="none">
            {statCell(row.deleted, props.statWidths.deleted, "-")}
          </text>
        ) : null}
      </box>
    </box>
  )
}
