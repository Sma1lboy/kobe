/** @jsxImportSource @opentui/react */
/**
 * The workspace center column — the terminal-in-the-middle seam (issue #16):
 * either the empty "select a task" placeholder or the selected worktree's
 * TerminalTabs (keyed per worktree so each task keeps its own registry-backed
 * PTYs). Split from host.tsx (file-size cap).
 */

import { type ReactNode, useSyncExternalStore } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { DEFAULT_TASK_VENDOR, type Task } from "../../types/task.ts"
import type { QuickTaskResult } from "../component/quick-task-composer"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { TerminalTabs } from "./TerminalTabs"

export function ShowWorkspace(props: {
  task: Task | undefined
  worktree: string | null
  orchestrator: RemoteOrchestrator
  focused: boolean
  onRequestFocus: () => void
  onEditorTabReady: (open: (command: readonly string[], label: string) => void) => void
  onEngineSendReady: (send: (text: string) => void) => void
  onQuickFork: (repo: string, result: QuickTaskResult) => void
  initialPrompt?: string
}): ReactNode {
  const { theme } = useTheme()
  const t = useT()
  const transcriptActivityStore = props.orchestrator.transcriptActivityStore()
  const transcriptActivity = useSyncExternalStore(
    transcriptActivityStore.subscribe,
    transcriptActivityStore.get,
    transcriptActivityStore.get,
  )
  if (!props.worktree) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={theme.textMuted}>{t("workspace.empty.selectTask")}</text>
      </box>
    )
  }
  const path = props.worktree
  return (
    // The terminal-in-the-middle seam (issue #16): the center column IS
    // the engine — an in-process PTY (Bun.spawn terminal) running the
    // real interactive CLI, so kobe never re-renders the engine's own
    // TUI. `key={path}` remounts per worktree, giving each task its own
    // registry-backed PTY (acquire reuses a live one on switch-back).
    <TerminalTabs
      key={path}
      taskId={props.task?.id ?? path}
      worktree={path}
      command={interactiveEngineCommand(props.task?.vendor, props.task?.modelEffort)}
      vendor={props.task?.vendor ?? DEFAULT_TASK_VENDOR}
      modelEffort={props.task?.modelEffort}
      onChooseEngine={
        props.task
          ? (vendor) => {
              const taskId = props.task?.id
              if (!taskId) return
              void props.orchestrator
                .setVendor(taskId, vendor)
                .catch((err) => console.error("[kobe workspace] task.setVendor failed:", err))
            }
          : undefined
      }
      focused={props.focused}
      onRequestFocus={props.onRequestFocus}
      onEditorTabReady={props.onEditorTabReady}
      onEngineSendReady={props.onEngineSendReady}
      onQuickFork={props.onQuickFork}
      initialPrompt={props.initialPrompt}
      // This worktree's slice of the daemon transcript.activity push
      // (issue #24) — flips the tab turn-status loops to shared mode.
      sharedActivity={transcriptActivity?.get(path) ?? null}
    />
  )
}
