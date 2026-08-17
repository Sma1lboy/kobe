/**
 * Scratch-task adoption loop (issues #33/#40) — the React binding over the
 * pure `decideScratchAdopt`. Every poll tick it asks, for each scratch task
 * with an attached live shell: where has the shell settled (live cwd → repo
 * main root), and is a coding harness confirmed running in it (the
 * live-engine store's walk — same confidence bar as tab identity). Both
 * true → the pure decision picks one of two moves:
 *
 *   - `fold` (issue #40): the cwd already belongs to an existing task —
 *     the shell (engine session and all) becomes that task's new terminal
 *     tab via `foldScratchShell`, and the emptied scratch row is deleted.
 *     No new task is minted, so the sidebar never grows a duplicate row
 *     for a directory it already lists.
 *   - `adopt`: no owner — the row migrates into that repo's project group
 *     via `orch.adoptScratchRepo`, exactly as before.
 *
 * Deliberately quiet (owner spec): no dialog, no focus steal. On adopt,
 * selection follows because it keys on the task id. On fold the id goes
 * away, so the caller's `onFold` re-points selection to the folded tab
 * ONLY when the scratch row was the selected one. An UNFAMILIAR repo
 * additionally surfaces a non-modal hint (notifyInfo) that the repo can be
 * saved as a project — the ask is about the savedRepos registry, never a
 * gate on the move itself.
 *
 * Only Rove-hosted PTYs are consulted (the local registry — attached tabs
 * of this TUI); an unattached scratch task simply waits. Cost: one lsof per
 * scratch task per tick, and scratch tasks are rare by construction.
 */

import { useEffect } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { processCwd } from "../../engine/process-cwd"
import { canonPath } from "../../orchestrator/core-helpers"
import { getSavedRepos, isGitRepo, resolveMainRepoRoot } from "../../state/repos"
import { t } from "../../tui/i18n"
import { repoBasename } from "../../tui/panes/sidebar/groups"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { getDefaultLiveEngines } from "../../tui/workspace/live-engine"
import { type ScratchOwnerTask, decideScratchAdopt } from "../../tui/workspace/scratch-adopt"
import { tabPtyKey } from "../../tui/workspace/terminal-tabs-core"
import type { Task } from "../../types/task"
import { useLatest } from "../lib/use-latest"
import { foldScratchShell } from "./scratch-fold"
import type { TabsSnapshotKv } from "./terminal-tabs-persist"

/** Same human timescale as the live-engine probe. */
const POLL_MS = 5_000

/** Tasks whose directory can already own a scratch shell's cwd. */
export function scratchOwnerTasks(tasks: readonly Task[]): ScratchOwnerTask[] {
  return tasks
    .filter((task) => !task.archived && !task.deletion && task.scratch !== true && task.worktreePath !== "")
    .map((task) => ({ id: task.id, kind: task.kind ?? "task", dir: canonPath(task.worktreePath) }))
}

export function useScratchAdopt(deps: {
  readonly tasks: readonly Task[]
  readonly orchestrator: RemoteOrchestrator
  readonly kv: TabsSnapshotKv
  /** Non-modal hint channel — the unfamiliar-repo "save as project?" nudge. */
  readonly notifyInfo: (message: string) => void
  /** The shell folded into `targetTaskId` as `tabId` — delete the emptied
   *  scratch row and follow selection if it pointed at the scratch task. */
  readonly onFold: (scratchTaskId: string, targetTaskId: string, tabId: string) => Promise<void>
  readonly enabled?: boolean
}): void {
  const { tasks, orchestrator, kv, notifyInfo } = deps
  // Latest-render mirror: the fold callback closes over host selection state
  // and is rebuilt every render — a dep would restart the poll per render.
  const onFoldRef = useLatest(deps.onFold)
  const enabled = deps.enabled ?? true
  const scratchIds = tasks
    .filter((t) => t.kind === "dir" && t.scratch === true)
    .map((t) => t.id)
    .join(",")

  useEffect(() => {
    if (!enabled || scratchIds === "") return
    let cancelled = false
    /** One adopt per task per mount — a slow RPC must not double-fire. */
    const inFlight = new Set<string>()

    const tick = async (): Promise<void> => {
      const scratch = tasks.filter((t) => t.kind === "dir" && t.scratch === true)
      if (scratch.length === 0) return
      const known = new Set<string>([...getSavedRepos(), ...tasks.map((t) => t.repo)])
      const owners = scratchOwnerTasks(tasks)
      const registry = getDefaultPtyRegistry()
      const liveEngines = getDefaultLiveEngines()
      for (const task of scratch) {
        if (inFlight.has(task.id)) continue
        // The scratch shell is tab-1 by construction (initialShellTabs).
        const key = tabPtyKey(task.id, "tab-1")
        const pid = registry.get(key)?.shellPid ?? null
        if (pid === null || pid === undefined) continue
        // Confidence gate: harness confirmed live under this shell.
        if (!liveEngines.get(key)) continue
        const rawCwd = await processCwd(pid)
        if (cancelled || !rawCwd) continue
        const cwd = canonPath(rawCwd)
        // resolveMainRepoRoot falls back to the input for non-repos, so
        // isGitRepo is the actual repo-semantics gate.
        const repoRoot = canonPath(resolveMainRepoRoot(cwd))
        const decision = decideScratchAdopt({
          cwd,
          repoRoot: isGitRepo(repoRoot) ? repoRoot : null,
          harnessLive: true,
          knownRepos: known,
          ownerTasks: owners,
        })
        if (cancelled || decision.kind === "stay") continue
        inFlight.add(task.id)
        try {
          if (decision.kind === "fold") {
            const folded = await foldScratchShell({ kv }, task.id, decision.taskId)
            // Null = nothing moved (old host / sessions gone): stay put and
            // retry next tick rather than minting the duplicate row.
            if (!folded) throw new Error("fold did not move any session")
            await onFoldRef.current(task.id, decision.taskId, folded.activeTabId)
            continue
          }
          await orchestrator.adoptScratchRepo(task.id, decision.repo)
          if (!decision.known) {
            // ponytail: non-modal hint instead of a save dialog — the move
            // itself must not gate on an answer (owner: no dialogs).
            notifyInfo(t("tasks.toast.scratchAdopted", { repo: repoBasename(decision.repo) }))
          }
        } catch {
          inFlight.delete(task.id) // retry next tick
        }
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // scratchIds is the reactive key — tasks identity churns every snapshot.
  }, [enabled, scratchIds, orchestrator, kv, notifyInfo, tasks])
}
