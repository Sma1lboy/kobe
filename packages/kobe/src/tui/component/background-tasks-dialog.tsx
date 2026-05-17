/**
 * Background-tasks manager — kobe's analogue to claude-code's
 * `BackgroundTasksDialog` (`refs/claude-code/src/components/tasks/`).
 *
 * Claude Code's model: a task is foreground by default; Ctrl+B moves it
 * to the background where it keeps running, visible only in a compact
 * indicator. kobe already runs every ChatTab session detached from UI
 * focus (the daemon owns the session, the pump is a background promise)
 * — what was missing is a single surface to see and manage everything
 * running out of view. This dialog is that surface.
 *
 * "Background" here = a ChatTab whose session is `running` /
 * `awaiting_input` AND is not the tab currently on screen. The visible
 * tab is excluded because the user is already looking at it (and its
 * own tab chip already paints a run-state dot).
 *
 * Interaction grammar borrows from `resume-dialog.tsx`:
 *   - one row per background session, j/k or ↑↓ to move
 *   - enter jumps to it (selects the task + activates the tab)
 *   - `x` interrupts the current turn (same effect as esc in chat)
 *   - esc dismisses (handled by DialogProvider's binding stack)
 */

import type { ChatRunState } from "@/orchestrator/core"
import type { Task } from "@/types/task"
import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createMemo, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import {
  BACKGROUND_TASKS_DIALOG_EMPTY,
  BACKGROUND_TASKS_DIALOG_FOOTER,
  BACKGROUND_TASKS_DIALOG_TITLE,
  type BackgroundTaskRow,
  computeBackgroundRows,
} from "./background-tasks-parts"

export interface BackgroundTasksDialogProps {
  /** Live per-tab run-state map (`orchestrator.chatRunStateSignal()`). */
  runState: Accessor<ReadonlyMap<string, ChatRunState>>
  /** Live task list (`orchestrator.tasksSignal()`). */
  tasks: Accessor<Task[]>
  /** `${taskId}:${tabId}` of the tab currently on screen, or null. */
  visibleTabKey: Accessor<string | null>
  /** Select the task + activate the tab + focus the chat pane. */
  onJump: (taskId: string, tabId: string) => void
  /** Interrupt the session's current turn (same effect as esc in chat). */
  onInterrupt: (taskId: string, tabId: string) => void
}

export function BackgroundTasksDialog(props: BackgroundTasksDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [cursor, setCursor] = createSignal(0)

  const rows = createMemo<readonly BackgroundTaskRow[]>(() =>
    computeBackgroundRows(props.runState(), props.tasks(), props.visibleTabKey()),
  )

  // Cursor never escapes the (shrinking) list — interrupting a row
  // drops it from `runState`, so the row count can fall under us.
  const safeCursor = createMemo(() => {
    const len = rows().length
    if (len === 0) return 0
    return Math.max(0, Math.min(len - 1, cursor()))
  })
  const move = (delta: number) => {
    const len = rows().length
    if (len === 0) return
    setCursor(Math.max(0, Math.min(len - 1, safeCursor() + delta)))
  }

  function jump(): void {
    const picked = rows()[safeCursor()]
    if (!picked) return
    props.onJump(picked.taskId, picked.tabId)
    dialog.clear()
  }

  function interrupt(): void {
    const picked = rows()[safeCursor()]
    if (!picked) return
    // Keep the dialog open — the user may want to interrupt several in
    // a row. The interrupted session leaves `runState` and its row
    // disappears on the next reactive tick.
    props.onInterrupt(picked.taskId, picked.tabId)
  }

  useBindings(() => ({
    bindings: [
      { key: "j", cmd: () => move(1) },
      { key: "down", cmd: () => move(1) },
      { key: "k", cmd: () => move(-1) },
      { key: "up", cmd: () => move(-1) },
      { key: "x", cmd: () => interrupt() },
      { key: "enter", cmd: () => jump() },
      { key: "return", cmd: () => jump() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {BACKGROUND_TASKS_DIALOG_TITLE}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show
        when={rows().length > 0}
        fallback={
          <box paddingTop={1} paddingBottom={1}>
            <text fg={theme.textMuted}>{BACKGROUND_TASKS_DIALOG_EMPTY}</text>
          </box>
        }
      >
        <scrollbox
          flexShrink={1}
          flexGrow={1}
          stickyScroll={false}
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.backgroundDialog, foregroundColor: theme.borderActive },
          }}
        >
          <box paddingBottom={1} gap={0} paddingRight={1}>
            <For each={rows()}>
              {(row, idx) => {
                const selected = () => idx() === safeCursor()
                const awaiting = () => row.state === "awaiting_input"
                return (
                  <box
                    flexDirection="row"
                    gap={2}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={selected() ? theme.primary : undefined}
                    onMouseDown={() => setCursor(idx())}
                    onMouseUp={() => jump()}
                  >
                    <box width={14} flexShrink={0}>
                      <text
                        fg={selected() ? theme.selectedListItemText : awaiting() ? theme.warning : theme.success}
                        wrapMode="none"
                      >
                        {awaiting() ? "● needs input" : "● running"}
                      </text>
                    </box>
                    <box flexGrow={1} flexShrink={1}>
                      <text fg={selected() ? theme.selectedListItemText : theme.text} wrapMode="none">
                        {row.taskTitle}
                      </text>
                    </box>
                    <box width={18} flexShrink={0}>
                      <text fg={selected() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                        {row.tabLabel}
                      </text>
                    </box>
                  </box>
                )
              }}
            </For>
          </box>
        </scrollbox>
      </Show>
      <box paddingTop={0} paddingBottom={1}>
        <text fg={theme.textMuted}>{BACKGROUND_TASKS_DIALOG_FOOTER}</text>
      </box>
    </box>
  )
}

/**
 * Convenience opener — pushes the background-tasks dialog onto the
 * dialog stack. Wired to the global `tasks.background` chord (ctrl+b).
 */
BackgroundTasksDialog.show = (dialog: DialogContext, props: BackgroundTasksDialogProps): void => {
  dialog.replace(() => <BackgroundTasksDialog {...props} />)
}
