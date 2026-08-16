/** @jsxImportSource @opentui/react */
/**
 * The workspace center column — the terminal-in-the-middle seam (issue #16):
 * either the empty "select a task" placeholder or the selected worktree's
 * TerminalTabs (keyed per task so tasks sharing a directory never share
 * component state). Split from host.tsx (file-size cap).
 */

import type { ReactNode } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { engineLaunchArgv } from "../../engine/engine-presets.ts"
import { DEFAULT_TASK_VENDOR, type Task } from "../../types/task.ts"
import type { QuickTaskResult } from "../component/quick-task-composer"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useAccessor } from "../lib/use-accessor"
import { TerminalTabs } from "./TerminalTabs"

export function ShowWorkspace(props: {
  task: Task | undefined
  worktree: string | null
  orchestrator: RemoteOrchestrator
  focused: boolean
  onRequestFocus: () => void
  onEditorTabReady: (open: (command: readonly string[], label: string) => void) => void
  onEngineSendReady: (send: (text: string) => void) => void
  onDiffTabReady: (open: (relPath: string, label: string, base?: string) => void) => void
  onQuickFork: (repo: string, result: QuickTaskResult) => void
  initialPrompt?: string
  /** The user landed on a tab of the selected task — resolve its episodes. */
  onTabVisited?: (taskId: string, tabId: string) => void
}): ReactNode {
  const { theme } = useTheme()
  const t = useT()
  const transcriptActivity = useAccessor(props.orchestrator.transcriptActivityStore())
  const engineTabStates = useAccessor(props.orchestrator.engineTabStatesSignal())
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
    // TUI. Keyed by TASK, not worktree: two tasks can share a directory
    // (a project-main task + a dir task on the same checkout), and a
    // path key reused the component across them — the stale task's
    // TabsState got written under the new task's persistKey, cloning its
    // tabs into the other task. PTY reuse on switch-back is unaffected:
    // the registry keys are `taskId::tabId`, not React keys.
    <TerminalTabs
      key={props.task?.id ?? path}
      taskId={props.task?.id ?? path}
      worktree={path}
      repo={props.task?.repo}
      taskKind={props.task?.kind}
      command={engineLaunchArgv({
        command: props.task?.command,
        vendor: props.task?.vendor,
        effort: props.task?.modelEffort,
      })}
      vendor={props.task?.vendor ?? DEFAULT_TASK_VENDOR}
      modelEffort={props.task?.modelEffort}
      onChooseEngine={
        props.task
          ? (vendor) => {
              const taskId = props.task?.id
              if (!taskId) return
              void props.orchestrator
                .setVendor(taskId, vendor)
                .catch((err) => console.error("[rove workspace] task.setVendor failed:", err))
            }
          : undefined
      }
      focused={props.focused}
      onRequestFocus={props.onRequestFocus}
      onEditorTabReady={props.onEditorTabReady}
      onEngineSendReady={props.onEngineSendReady}
      onDiffTabReady={props.onDiffTabReady}
      onQuickFork={props.onQuickFork}
      initialPrompt={props.initialPrompt}
      // This worktree's slice of the daemon transcript.activity push
      // (issue #24) — flips the tab turn-status loops to shared mode.
      sharedActivity={transcriptActivity?.get(path) ?? null}
      // This task's slice of the hook-driven per-tab engine state — the
      // sub-second chip/notification source (poll stays as fallback).
      hookTabStates={props.task ? engineTabStates.get(props.task.id) : undefined}
      taskTitle={props.task?.title}
      onTabVisited={(tabId) => {
        const taskId = props.task?.id
        if (taskId) props.onTabVisited?.(taskId, tabId)
      }}
      // A confirmed ESC interrupt (hook still claims running, live title
      // says the engine rested — issue #15) is reported as the
      // `turn-interrupted` the engine's abort path never fires itself.
      onEngineInterrupt={(tabId) => {
        const taskId = props.task?.id
        if (taskId) props.orchestrator.reportEngineInterrupt(taskId, tabId)
      }}
    />
  )
}
