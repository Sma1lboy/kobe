/**
 * Solid view for a single file tree row — split out of `FileTree.tsx`
 * (issue #15, G3; the component was over the 500-line cap). Pure render:
 * all row math (stat widths, path budget, status→token mapping) comes from
 * the shared framework-free `pane-core.ts`.
 *
 * Cursor row treatment — matches the Sidebar: a left accent ▌
 * (focusAccent) + a subtle `backgroundElement` tint, NOT a solid
 * terracotta fill, so the semantic colours survive instead of being
 * flattened to inverted text. A bare space holds the 1-cell gutter on
 * non-cursor rows so content stays aligned.
 */

import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { type StatWidths, statCell, statusToken } from "./pane-core"
import type { Row } from "./rows"
import { truncatePathTail } from "./rows"

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
  const rowBg = () => (props.cursor ? theme.backgroundElement : undefined)
  const row = props.row
  if (row.kind === "dir") {
    // Indent: 2 cells per depth level. Marker: ▾ open, ▸ closed.
    const indent = "  ".repeat(row.depth)
    return (
      <box flexDirection="row" gap={0} backgroundColor={rowBg()} onMouseUp={() => props.onActivate()}>
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
      <box flexDirection="row" gap={0} backgroundColor={rowBg()} onMouseUp={() => props.onActivate()}>
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
  const statusColor = () => {
    switch (tone) {
      case "success":
        return theme.success
      case "warning":
        return theme.warning
      case "error":
        return theme.error
      case "info":
        return theme.info
      default:
        return theme.textMuted
    }
  }
  return (
    <box flexDirection="row" gap={0} backgroundColor={rowBg()} onMouseUp={() => props.onActivate()}>
      {bar}
      <box flexDirection="row" flexGrow={1} gap={1} paddingRight={1}>
        <text fg={statusColor()} wrapMode="none">
          {row.status}
        </text>
        <text fg={theme.text} wrapMode="none" flexGrow={1}>
          {truncatePathTail(row.path, props.pathBudget)}
        </text>
        <Show when={props.statWidths.added > 0}>
          <text fg={theme.success} wrapMode="none">
            {statCell(row.added, props.statWidths.added, "+")}
          </text>
        </Show>
        <Show when={props.statWidths.deleted > 0}>
          <text fg={theme.error} wrapMode="none">
            {statCell(row.deleted, props.statWidths.deleted, "-")}
          </text>
        </Show>
      </box>
    </box>
  )
}
