/**
 * Scratch-task adoption loop (issue #33) — the React binding over the pure
 * `decideScratchAdopt`. Every poll tick it asks, for each scratch task with
 * an attached live shell: where has the shell settled (live cwd → repo main
 * root), and is a coding harness confirmed running in it (the live-engine
 * store's walk — same confidence bar as tab identity). Both true → the row
 * migrates into that repo's project group via `orch.adoptScratchRepo`.
 *
 * Deliberately quiet (owner spec): no dialog, no focus steal — the row
 * simply moves; selection follows because it keys on the task id, which
 * never changes. An UNFAMILIAR repo additionally surfaces a non-modal hint
 * (notifyInfo) that the repo can be saved as a project — the ask is about
 * the savedRepos registry, never a gate on the move itself.
 *
 * Only Rove-hosted PTYs are consulted (the local registry — attached tabs
 * of this TUI); an unattached scratch task simply waits. Cost: one lsof per
 * scratch task per tick, and scratch tasks are rare by construction.
 */

import { useEffect } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { processCwd } from "../../engine/process-cwd"
import { getSavedRepos, isGitRepo, resolveMainRepoRoot } from "../../state/repos"
import { t } from "../../tui/i18n"
import { repoBasename } from "../../tui/panes/sidebar/groups"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { getDefaultLiveEngines } from "../../tui/workspace/live-engine"
import { decideScratchAdopt } from "../../tui/workspace/scratch-adopt"
import { tabPtyKey } from "../../tui/workspace/terminal-tabs-core"
import type { Task } from "../../types/task"

/** Same human timescale as the live-engine probe. */
const POLL_MS = 5_000

export function useScratchAdopt(deps: {
  readonly tasks: readonly Task[]
  readonly orchestrator: RemoteOrchestrator
  /** Non-modal hint channel — the unfamiliar-repo "save as project?" nudge. */
  readonly notifyInfo: (message: string) => void
  readonly enabled?: boolean
}): void {
  const { tasks, orchestrator, notifyInfo } = deps
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
        const cwd = await processCwd(pid)
        if (cancelled || !cwd) continue
        // resolveMainRepoRoot falls back to the input for non-repos, so
        // isGitRepo is the actual repo-semantics gate.
        const repoRoot = resolveMainRepoRoot(cwd)
        const decision = decideScratchAdopt({
          repoRoot: isGitRepo(repoRoot) ? repoRoot : null,
          harnessLive: true,
          knownRepos: known,
        })
        if (cancelled || decision.kind !== "adopt") continue
        inFlight.add(task.id)
        try {
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
  }, [enabled, scratchIds, orchestrator, notifyInfo, tasks])
}
