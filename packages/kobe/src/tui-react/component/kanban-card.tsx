/** @jsxImportSource @opentui/react */
/**
 * KanbanCard — one issue card on the board (extracted from kanban-page.tsx
 * for the file-size cap). Selection border > attention border > column
 * border; a live activity badge tracks the linked task's engine on both the
 * In-progress and Parked columns (a parked card keeps its badge as passive
 * signal — it just never floats or counts toward "N need you").
 */

import { TextAttributes } from "@opentui/core"
import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import type { ReactNode } from "react"
import type { TaskActivityState } from "../../engine/hook-events"
import { type BoardColumnKey, isBoardAttentionState } from "../../state/issue-board"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"

/** Live activity badge on a linked card, keyed by the linked task's engine
 *  state — how the board tracks a background start without leaving the page.
 *  `idle` (and unknown) draw nothing: the card's presence in the column
 *  already says "started". */
const ACTIVITY_BADGE: Partial<
  Record<TaskActivityState, { labelKey: string; tone: "accent" | "warning" | "error" | "success" }>
> = {
  running: { labelKey: "tasks.status.working", tone: "accent" },
  turn_complete: { labelKey: "kanban.turnComplete", tone: "success" },
  rate_limited: { labelKey: "tasks.activity.rateLimited", tone: "warning" },
  permission_needed: { labelKey: "tasks.activity.permissionNeeded", tone: "warning" },
  error: { labelKey: "tasks.activity.error", tone: "error" },
}

export function KanbanCard(props: {
  issue: Issue
  column: BoardColumnKey
  selected: boolean
  /** The linked task's live engine state (undefined = unlinked/vanished). */
  activity: TaskActivityState | undefined
  /** First click selects; a click on the already-selected card opens its
   *  detail drawer (Enter's mouse twin). */
  onSelect: () => void
  onOpen: () => void
}): ReactNode {
  const { theme, transparentBackground } = useTheme()
  const t = useT()
  const { issue, column, selected } = props
  const columnBorder = transparentBackground ? theme.border : theme.borderSubtle
  const fg = column === "done" ? theme.textMuted : theme.text
  const description = issue.body.trim()
  const badge = props.activity ? ACTIVITY_BADGE[props.activity] : undefined
  // Attention cards (blocked on the user — floated to the In-progress head by
  // applyBoardAttention) carry a warning border so the group reads as one
  // block; the selection highlight still wins.
  const needsAttention = isBoardAttentionState(props.activity)
  const badgeTone = {
    accent: theme.accent,
    warning: theme.warning,
    error: theme.error,
    success: theme.success,
  } as const
  // backgroundElement survives transparent mode on purpose (see
  // applyDisplayOverlay): cards are content, not chrome — they keep a
  // tinted surface so the board reads against any host wallpaper.
  return (
    <box
      border={true}
      borderColor={selected ? theme.primary : needsAttention ? theme.warning : columnBorder}
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      onMouseUp={() => (selected ? props.onOpen() : props.onSelect())}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={fg} attributes={TextAttributes.BOLD} wrapMode="word" flexShrink={1}>
          {issue.title}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          #{issue.id}
        </text>
      </box>
      {/* Two-line preview is deliberate card grammar: enough room for a
          description now, with a stable region for the future editor. */}
      <box height={2} overflow="hidden">
        {description ? (
          <text fg={theme.textMuted} wrapMode="word">
            {description}
          </text>
        ) : null}
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted} wrapMode="none">
          {issue.created}
        </text>
        {badge ? (
          <text fg={badgeTone[badge.tone]} wrapMode="none">
            {t(badge.labelKey)}
          </text>
        ) : null}
      </box>
    </box>
  )
}
