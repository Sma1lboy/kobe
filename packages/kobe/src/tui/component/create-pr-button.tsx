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
import { type Accessor, createEffect, onCleanup } from "solid-js"
import type { KobeOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"
import { useTheme } from "../context/theme"
import { describePRChip, shouldPollPRStatus } from "./create-pr-state"

export type CreatePRButtonProps = {
  orchestrator: KobeOrchestrator
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

  createEffect(() => {
    const task = props.activeTask()
    if (!task || !isEnabled(task) || !shouldPollPRStatus(task.prStatus)) return
    const refresh = () => {
      props.orchestrator.refreshPRStatus(task.id).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[kobe] refreshPRStatus failed:", err)
      })
    }
    refresh()
    const interval = setInterval(refresh, 30_000)
    onCleanup(() => clearInterval(interval))
  })

  function onClick(): void {
    const task = props.activeTask()
    if (!isEnabled(task) || !task) return
    if (task.prStatus?.provider === "github" && task.prStatus.lifecycle === "ready_to_merge") {
      props.orchestrator.requestPRMerge(task.id).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[kobe] requestPRMerge failed:", err)
      })
      return
    }
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
  const state = () => describePRChip(props.activeTask()?.prStatus)
  // BOLD accent brackets for the "key" slot (matches the Hotkey chip);
  // dim to muted when the button is unusable so it reads as inactive.
  const bracketColor = () => {
    if (!enabled()) return theme.textMuted
    const tone = state().tone
    if (tone === "error") return theme.error
    if (tone === "warning") return theme.warning
    return theme.accent
  }
  const labelColor = () => {
    if (!enabled()) return theme.textMuted
    const tone = state().tone
    if (tone === "error") return theme.error
    if (tone === "warning") return theme.warning
    return tone === "accent" ? theme.accent : theme.textMuted
  }

  return (
    <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={enabled() ? onClick : undefined}>
      <text fg={bracketColor()} attributes={TextAttributes.BOLD} wrapMode="none">
        {state().key}
      </text>
      <text fg={labelColor()} wrapMode="none">
        {state().label}
      </text>
    </box>
  )
}
