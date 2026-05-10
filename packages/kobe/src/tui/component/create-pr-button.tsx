/**
 * Create-PR button (Wave 4 stream W4.PR).
 *
 * Renders inside the top bar at the right edge. Clicking it asks the
 * orchestrator to inject a preset PR-creation prompt into the active
 * task's chat session. kobe does NOT call git itself — see
 * `src/orchestrator/pr/instructions.ts` for the rationale.
 *
 * Visual grammar matches the agent-deck `[Tab] label` chip aesthetic
 * already used by `Hotkey()` in `app.tsx`: brackets in BOLD accent for
 * the "key" slot, label following in regular text. Disabled state dims
 * to muted text and removes the click handler.
 *
 * Mouse handling uses `onMouseUp` per project convention — the rest of
 * the codebase uses `onMouseUp` for pane focus + interaction; sticking
 * to it keeps event semantics consistent across components.
 */

import { TextAttributes } from "@opentui/core"
import type { Accessor } from "solid-js"
import type { Orchestrator } from "../../orchestrator/core.ts"
import type { Task } from "../../types/task.ts"
import { useTheme } from "../context/theme"

export type CreatePRButtonProps = {
  orchestrator: Orchestrator
  /**
   * Solid accessor for the currently active task. Undefined when no
   * task is selected; a task with empty `worktreePath` indicates the
   * createTask placeholder window. In both cases the button renders
   * disabled.
   */
  activeTask: Accessor<Task | undefined>
}

/** Whether the button is interactive given the current active task. */
function isEnabled(task: Task | undefined): boolean {
  if (!task) return false
  if (!task.worktreePath) return false
  if (task.status === "canceled") return false
  return true
}

export function CreatePRButton(props: CreatePRButtonProps) {
  const { theme } = useTheme()

  function onClick(): void {
    const task = props.activeTask()
    if (!isEnabled(task) || !task) return
    props.orchestrator.requestPR(task.id).catch((err: unknown) => {
      // Don't re-throw: the agent's chat will surface user-facing
      // messaging once the preset prompt lands and runs. The console
      // log here is the developer-facing trail (matches the
      // [kobe] prefix already used by app.tsx).
      // eslint-disable-next-line no-console
      console.error("[kobe] requestPR failed:", err)
    })
  }

  const enabled = () => isEnabled(props.activeTask())
  // BOLD accent brackets for the "key" slot (matches the Hotkey chip);
  // dim to muted when the button is unusable so it reads as inactive.
  const bracketColor = () => (enabled() ? theme.accent : theme.textMuted)
  const labelColor = () => (enabled() ? theme.textMuted : theme.textMuted)

  return (
    <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={enabled() ? onClick : undefined}>
      <text fg={bracketColor()} attributes={TextAttributes.BOLD} wrapMode="none">
        [PR]
      </text>
      <text fg={labelColor()} wrapMode="none">
        Create PR
      </text>
    </box>
  )
}
