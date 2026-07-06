/** @jsxImportSource @opentui/react */
/**
 * React view for a single file tree row — the `src/tui/panes/filetree/
 * row-view.tsx` counterpart (issue #15, G3). Pure render: all row math
 * (stat widths, path budget, status→token mapping) comes from the shared
 * framework-free `pane-core.ts`, so the two runtimes render identically.
 *
 * Cursor row treatment — matches the Sidebar: a left accent ▌
 * (focusAccent) + a subtle `backgroundElement` tint, NOT a solid
 * terracotta fill, so the semantic colours survive instead of being
 * flattened to inverted text. A bare space holds the 1-cell gutter on
 * non-cursor rows so content stays aligned.
 */

import { TextAttributes } from "@opentui/core"
import { type StatWidths, statCell, statusToken } from "../../../tui/panes/filetree/pane-core"
import { type Row, truncatePathTail } from "../../../tui/panes/filetree/rows"
import { useTheme } from "../../context/theme"

export type FileTreeRowProps = {
  row: Row
  /** Whether the cursor sits on this row. */
  cursor: boolean
  /** Shared stat column widths (Changes tab). */
  statWidths: StatWidths
  /** Path cell budget (Changes tab). */
  pathBudget: number
  /** Mouse activation: sets the cursor here and opens/toggles the row. */
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
    // Indent: 2 cells per depth level. Marker: ▾ open, ▸ closed.
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
    // Two-cell gutter where the dir marker would sit.
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
  // Changes row: status char + path + +N -N stats.
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
