/**
 * Status-bar background-tasks indicator.
 *
 * Renders nothing when no session is running out of view; otherwise a
 * compact chip showing how many ChatTab sessions are running in the
 * background and the chord to open the manager dialog. Mirrors
 * claude-code's `BackgroundTaskStatus` — a quiet, count-only affordance
 * that only appears when there's something to manage.
 *
 * "Background" is computed by {@link computeBackgroundRows}: running /
 * awaiting_input sessions minus the tab currently on screen. When any
 * background session is blocked on the user (`awaiting_input`), the
 * count is painted in the warning color so a needs-input session can't
 * be silently lost behind another task.
 *
 * Double-press: while the ctrl+b chord is armed (first of two presses
 * inside the 800ms window — see `pressBackgroundTasksChord`), the chip
 * swaps to a "press ctrl+b again" hint so the user knows the first
 * press registered. The chip stays visible while armed even when the
 * count is zero, so the double-press still gives feedback when nothing
 * is running.
 */

import type { ChatRunState } from "@/orchestrator/core"
import type { Task } from "@/types/task"
import { TextAttributes } from "@opentui/core"
import { type Accessor, Show, createMemo } from "solid-js"
import { useBackgroundTasksArmed } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { computeBackgroundRows } from "./background-tasks-parts"

export interface BackgroundTasksIndicatorProps {
  runState: Accessor<ReadonlyMap<string, ChatRunState>>
  tasks: Accessor<Task[]>
  visibleTabKey: Accessor<string | null>
  /** Open the background-tasks dialog (chip is mouse-clickable). */
  onActivate: () => void
}

export function BackgroundTasksIndicator(props: BackgroundTasksIndicatorProps) {
  const { theme } = useTheme()
  const armed = useBackgroundTasksArmed()
  const rows = createMemo(() => computeBackgroundRows(props.runState(), props.tasks(), props.visibleTabKey()))
  const count = () => rows().length
  const anyAwaiting = () => rows().some((r) => r.state === "awaiting_input")

  return (
    <Show when={count() > 0 || armed()}>
      <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={() => props.onActivate()}>
        <Show
          when={armed()}
          fallback={
            <>
              <text fg={anyAwaiting() ? theme.warning : theme.success} attributes={TextAttributes.BOLD} wrapMode="none">
                ⦿ {count()}
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                background
              </text>
              <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                [ctrl+b]
              </text>
            </>
          }
        >
          <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
            press ctrl+b again
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {count() > 0 ? `for ${count()} background` : "for background tasks"}
          </text>
        </Show>
      </box>
    </Show>
  )
}
