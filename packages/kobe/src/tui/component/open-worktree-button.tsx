/**
 * Opens the active task worktree in the dynamically detected editor.
 *
 * Visual style mirrors CreatePRButton: a small agent-deck-style chip in
 * the top bar, disabled when no task/worktree/opener is available.
 */

import { TextAttributes } from "@opentui/core"
import type { Accessor } from "solid-js"
import type { Task } from "../../types/task.ts"
import { useTheme } from "../context/theme"
import { type WorktreeOpener, openWorktree } from "../lib/worktree-opener"

export type OpenWorktreeButtonProps = {
  activeTask: Accessor<Task | undefined>
  opener: Accessor<WorktreeOpener | null>
}

function canOpen(task: Task | undefined, opener: WorktreeOpener | null): boolean {
  return Boolean(task?.worktreePath && opener)
}

export function OpenWorktreeButton(props: OpenWorktreeButtonProps) {
  const { theme } = useTheme()
  const enabled = () => canOpen(props.activeTask(), props.opener())
  const label = () => props.opener()?.label ?? "Editor"
  const color = () => (enabled() ? theme.accent : theme.textMuted)

  function onClick(): void {
    const task = props.activeTask()
    const opener = props.opener()
    if (!task?.worktreePath || !opener) return
    if (!openWorktree(task.worktreePath, opener)) {
      // eslint-disable-next-line no-console
      console.error("[kobe] failed to open worktree:", task.worktreePath)
    }
  }

  return (
    <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={enabled() ? onClick : undefined}>
      <text fg={color()} attributes={TextAttributes.BOLD} wrapMode="none">
        [Open]
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        {label()}
      </text>
    </box>
  )
}
