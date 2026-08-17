/**
 * Scratch temp shell tasks (issue #33) — the host-side lifecycle wiring:
 *
 *   - `openScratchShell` (ctrl+e dialog's trailing "scratch shell" choice —
 *     the prefix+t chord was rejected, owner 2026-08-16): create a scratch
 *     dir task rooted at $HOME and enter it. The task's tab-1 spawns as a
 *     bare shell (TerminalTabs' scratch mode); the row lives in the
 *     sidebar's Scratch section.
 *   - `onScratchExit`: the last shell exited — delete the row outright,
 *     zero ceremony (no archive, no confirm; a scratch task owns no
 *     worktree/branch, deletion only drops the index entry).
 *   - the fold finish (issue #40): the adoption loop moved the shell's
 *     sessions under an existing task — quietly re-point selection to the
 *     folded tab (ONLY when the scratch row was the selected one; a
 *     background fold must not move the user), then delete the emptied
 *     row. Deletion AFTER the rename, so the daemon's task-snapshot pty
 *     sweep sees the sessions under a live task id and spares them.
 *
 * The adoption loop (cwd + harness → project migration) is its own hook,
 * `use-scratch-adopt.ts`.
 */

import { homedir } from "node:os"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { t } from "../../tui/i18n"
import { finishDeletedTaskFlow } from "../../tui/lib/task-actions"
import type { Task } from "../../types/task"
import type { TabsSnapshotKv } from "./terminal-tabs-persist"
import { requestTabActivation } from "./terminal-tabs-shared"
import { useScratchAdopt } from "./use-scratch-adopt"

/** Task ids whose scratch teardown already started — module-level so the
 *  guard survives the hook being rebuilt every render. Never cleared: a
 *  torn-down scratch task's id is retired with it. */
const scratchTeardowns = new Set<string>()

export function useScratchShell(deps: {
  readonly orchestrator: RemoteOrchestrator
  readonly tasks: readonly Task[]
  readonly kv: TabsSnapshotKv
  readonly selectedId: () => string | null
  readonly selectTask: (taskId: string) => void
  readonly enterTask: (taskId: string) => void
  readonly forgetTaskTabs: (taskId: string) => void
  readonly notifyError: (message: string) => void
  readonly notifyInfo: (message: string) => void
}): {
  openScratchShell: () => void
  onScratchExit: (taskId: string) => void
} {
  const { orchestrator, enterTask, forgetTaskTabs, notifyError } = deps

  // The quiet cwd+harness adoption loop rides along: one hook is the whole
  // scratch lifecycle from the host's perspective. Fold (issue #40) hands
  // back here for the selection follow-up + row deletion.
  useScratchAdopt({
    tasks: deps.tasks,
    orchestrator,
    kv: deps.kv,
    notifyInfo: deps.notifyInfo,
    onFold: async (scratchTaskId, targetTaskId, tabId) => {
      // Selection follows the shell the user was watching — before the
      // delete, so the deleted-selection fallback never picks a stranger.
      if (deps.selectedId() === scratchTaskId) {
        deps.selectTask(targetTaskId)
        requestTabActivation(targetTaskId, tabId)
      }
      await orchestrator.deleteTask(scratchTaskId, { force: true })
      forgetTaskTabs(scratchTaskId)
    },
  })

  const openScratchShell = (): void => {
    void orchestrator
      .openDirectoryTask({ dir: homedir(), scratch: true })
      .then((task) => enterTask(task.id))
      .catch((err) =>
        notifyError(t("tasks.toast.scratchOpenFailed", { message: err instanceof Error ? err.message : String(err) })),
      )
  }

  const onScratchExit = (taskId: string): void => {
    // Idempotence: ctrl+w on the last tab (issue #42) kills the live PTY,
    // whose exit event re-enters this teardown before the delete lands —
    // the second call would surface a spurious "task not found" toast.
    if (scratchTeardowns.has(taskId)) return
    scratchTeardowns.add(taskId)
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
