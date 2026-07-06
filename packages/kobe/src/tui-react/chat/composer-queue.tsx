/** @jsxImportSource @opentui/react */
/**
 * React mid-turn prompt queue panel — the `src/tui/chat/ComposerQueue.tsx`
 * counterpart (issue #15 G3). Same visual grammar; the entry shape is the
 * shared framework-free `composer/queue-item`.
 */

import { TextAttributes } from "@opentui/core"
import type { ComposerQueuedItem } from "../../tui/chat/composer/queue-item"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"

export type { ComposerQueuedItem } from "../../tui/chat/composer/queue-item"

/**
 * Hard cap on visible queued rows so a fast typist who stacked many
 * prompts doesn't push the textarea off-screen. Overflow rolls up
 * into a single muted `+ N more queued` summary row.
 */
const QUEUE_VISIBLE_CAP = 4

export interface ComposerQueueProps {
  readonly queue: readonly ComposerQueuedItem[]
  /**
   * Whether auto-drain is paused. When true the panel swaps the
   * head-row hint to `(paused)` and offers a resume toggle; the
   * parent skips draining queued items as turns end.
   */
  readonly paused?: boolean
  /** Toggle the queue-paused flag (pause / resume). */
  readonly onTogglePause?: () => void
  readonly editingQueueId?: string | null
  readonly onEditQueued?: (id: string) => void
  readonly onSendQueuedNow?: (id: string) => void
  readonly onCancelQueued?: (id: string) => void
}

export function ComposerQueue(props: ComposerQueueProps) {
  const { theme } = useTheme()
  const t = useT()
  if (props.queue.length === 0) return null
  return (
    <box flexDirection="column" paddingBottom={1}>
      {props.queue.slice(0, QUEUE_VISIBLE_CAP).map((entry, idx) => {
        const isPrompt = entry.kind === "prompt"
        const isEditing = props.editingQueueId === entry.id
        const onRowEdit = () => props.onEditQueued?.(entry.id)
        return (
          <box key={entry.id} flexDirection="row" gap={1} alignItems="flex-start">
            <box
              flexDirection="row"
              gap={1}
              alignItems="flex-start"
              flexGrow={1}
              onMouseUp={isPrompt ? onRowEdit : undefined}
            >
              <text fg={isEditing ? theme.primary : theme.textMuted} attributes={TextAttributes.BOLD}>
                ○
              </text>
              <text fg={props.paused ? theme.warning : theme.textMuted} wrapMode="none">
                {t("chat.composer.queuedLabel")}
                {idx === 0 ? ` ${props.paused ? t("chat.composer.queuedPaused") : t("chat.composer.queuedNext")}` : ""}:
              </text>
              {entry.kind === "bash" ? (
                <text fg={theme.warning} wrapMode="none">
                  {t("chat.composer.queuedBash")}
                </text>
              ) : null}
              <box flexGrow={1}>
                <text fg={theme.text}>{entry.kind === "bash" ? entry.command : entry.text}</text>
              </box>
            </box>
            {isPrompt ? (
              /* Single-letter chip — consistent with the `[↑]` send-now and
                 `[x]` cancel chips on the same row. Pure ASCII (the `✎`
                 dingbat rendered thin/ugly across terminals). */
              <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={onRowEdit}>
                [e]
              </text>
            ) : null}
            <text
              fg={theme.primary}
              attributes={TextAttributes.BOLD}
              onMouseUp={() => props.onSendQueuedNow?.(entry.id)}
            >
              [↑]
            </text>
            <text fg={theme.error} attributes={TextAttributes.BOLD} onMouseUp={() => props.onCancelQueued?.(entry.id)}>
              [x]
            </text>
          </box>
        )
      })}
      {props.queue.length > QUEUE_VISIBLE_CAP ? (
        <box flexDirection="row" gap={1} alignItems="flex-start">
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            +
          </text>
          <text fg={theme.textMuted}>
            {t("chat.composer.moreQueued", { count: props.queue.length - QUEUE_VISIBLE_CAP })}
          </text>
        </box>
      ) : null}
      {/* Queue-level pause toggle — deliberately the lowest-priority
          affordance in the panel (a single muted row beneath the items). */}
      {props.onTogglePause ? (
        <box flexDirection="row" paddingTop={props.queue.length > QUEUE_VISIBLE_CAP ? 0 : 1}>
          <text
            fg={props.paused ? theme.warning : theme.textMuted}
            attributes={props.paused ? TextAttributes.BOLD : undefined}
            onMouseUp={() => props.onTogglePause?.()}
          >
            {props.paused ? t("chat.composer.resumeQueue") : t("chat.composer.pauseQueue")}
          </text>
        </box>
      ) : null}
    </box>
  )
}
