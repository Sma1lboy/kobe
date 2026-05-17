/**
 * Background-runs line — a one-row readout shown directly above the
 * chat composer listing the agent sessions running out of view.
 *
 * This is kobe's adaptation of claude-code's `BackgroundTaskStatus`,
 * which claude-code mounts in its `PromptInput` footer so the user can
 * see which agents are working in the background while they compose
 * their next message. kobe's case differs — each "background run" is a
 * ChatTab session in another task rather than an in-process sub-agent —
 * but the placement (attached to the composer) and intent (ambient,
 * glanceable, never steals focus) are the same.
 *
 * Self-hides when nothing runs out of view. Caps the inline pill list
 * so a long list can't push the composer around; the overflow folds
 * into a `+N` chip. The whole line is mouse-clickable and opens the
 * background-tasks dialog (same target as ctrl+b).
 */

import type { BackgroundTaskRow } from "@/tui/component/background-tasks-parts"
import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"

/** Max pills rendered inline before the rest fold into a `+N` chip. */
const MAX_INLINE_PILLS = 3

export interface BackgroundRunsLineProps {
  /** Background sessions (running / awaiting_input, minus the visible tab). */
  rows: Accessor<readonly BackgroundTaskRow[]>
  /** Open the background-tasks dialog. */
  onActivate: () => void
}

export function BackgroundRunsLine(props: BackgroundRunsLineProps) {
  const { theme } = useTheme()
  const shown = () => props.rows().slice(0, MAX_INLINE_PILLS)
  const overflow = () => Math.max(0, props.rows().length - MAX_INLINE_PILLS)

  return (
    <Show when={props.rows().length > 0}>
      <box
        flexDirection="row"
        gap={1}
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        onMouseUp={() => props.onActivate()}
      >
        <text fg={theme.textMuted} wrapMode="none">
          running in background
        </text>
        <For each={shown()}>
          {(row) => {
            const awaiting = row.state === "awaiting_input"
            return (
              <text fg={awaiting ? theme.warning : theme.success} wrapMode="none">
                ▪ {row.taskTitle}
                {awaiting ? " (needs input)" : ""}
              </text>
            )
          }}
        </For>
        <Show when={overflow() > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            +{overflow()}
          </text>
        </Show>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          [ctrl+b]
        </text>
      </box>
    </Show>
  )
}
