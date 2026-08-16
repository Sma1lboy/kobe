/**
 * Scratch temp shell tasks (issue #33) — the host-side lifecycle wiring:
 *
 *   - `openScratchShell` (PROPOSED prefix+t): create a scratch dir task
 *     rooted at $HOME and enter it. The task's tab-1 spawns as a bare shell
 *     (TerminalTabs' scratch mode); the row lives in the sidebar's Scratch
 *     section.
 *   - `onScratchExit`: the last shell exited — delete the row outright,
 *     zero ceremony (no archive, no confirm; a scratch task owns no
 *     worktree/branch, deletion only drops the index entry).
 *
 * The adoption loop (cwd + harness → project migration) is its own hook,
 * `use-scratch-adopt.ts`.
 */

import { homedir } from "node:os"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { t } from "../../tui/i18n"
import { finishDeletedTaskFlow } from "../../tui/lib/task-actions"
import type { Task } from "../../types/task"
import { useScratchAdopt } from "./use-scratch-adopt"

export function useScratchShell(deps: {
  readonly orchestrator: RemoteOrchestrator
  readonly tasks: readonly Task[]
  readonly enterTask: (taskId: string) => void
  readonly forgetTaskTabs: (taskId: string) => void
  readonly notifyError: (message: string) => void
  readonly notifyInfo: (message: string) => void
}): {
  openScratchShell: () => void
  onScratchExit: (taskId: string) => void
} {
  const { orchestrator, enterTask, forgetTaskTabs, notifyError } = deps

  // The quiet cwd+harness → project adoption loop rides along: one hook is
  // the whole scratch lifecycle from the host's perspective.
  useScratchAdopt({ tasks: deps.tasks, orchestrator, notifyInfo: deps.notifyInfo })

  const openScratchShell = (): void => {
    void orchestrator
      .openDirectoryTask({ dir: homedir(), scratch: true })
      .then((task) => enterTask(task.id))
      .catch((err) =>
        notifyError(t("tasks.toast.scratchOpenFailed", { message: err instanceof Error ? err.message : String(err) })),
      )
  }

  const onScratchExit = (taskId: string): void => {
    void (async () => {
      try {
        await orchestrator.deleteTask(taskId, { force: true })
        forgetTaskTabs(taskId)
        await finishDeletedTaskFlow({
          orch: orchestrator,
          tasks: deps.tasks,
          taskId,
          logger: console,
          logPrefix: "[rove scratch]",
          // The exiting shell IS the session you were in — re-point focus.
          updateActiveTask: true,
        })
      } catch (err) {
        notifyError(t("tasks.toast.scratchCloseFailed", { message: err instanceof Error ? err.message : String(err) }))
      }
    })()
  }

  return { openScratchShell, onScratchExit }
}
