/**
 * Quick-fork (issue #17, KOB-74) — resolve the composer's seed defaults from
 * the active task, and drive `orch.createTask` with the same tmux-parity
 * side effects `quick-task/host.tsx` and the shared `createTaskFlow`
 * (`tui/lib/task-actions.ts`) both perform: `addSavedRepo` + `setRepoLastActiveVendor`
 * before create, `selectTask`/`enterTask` after.
 *
 * Split out of `TerminalTabs.tsx`/`host.tsx` purely for the file-size cap —
 * both hosts sit close to the 500-line limit already.
 */

import { engineDisplayName } from "../../engine/interactive-command"
import { addSavedRepo } from "../../state/repos"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs"
import { DEFAULT_BASE_REF, getCurrentBranch } from "../../tui/lib/git-snapshot"
import { repoBasename } from "../../tui/panes/sidebar/groups"
import type { Task, VendorId } from "../../types/task"
import type { QuickTaskComposerOptions } from "../component/quick-task-composer"

/** Seed the composer from the task a quick-fork chord fired in. */
export function quickForkComposerOptions(
  repo: string,
  engines: readonly VendorId[],
  defaultVendor: VendorId,
): QuickTaskComposerOptions {
  return {
    repoLabel: repoBasename(repo),
    engines,
    defaultVendor,
    defaultBaseRef: getCurrentBranch(repo) ?? DEFAULT_BASE_REF,
    engineLabel: engineDisplayName,
  }
}

/** Vendor to preselect: the repo's last-active engine, clamped to a detected one. */
export function quickForkDefaultVendor(repo: string, detected: readonly VendorId[]): VendorId {
  const pref = resolvePreferredVendor(repo)
  if (detected.length === 0 || detected.includes(pref)) return pref
  return detected[0] ?? pref
}

export interface QuickForkOrchestrator {
  createTask(input: { repo: string; baseRef: string; vendor: VendorId }): Promise<Task>
}

/**
 * Create the forked task and apply the same tmux-parity side effects
 * `createTaskFlow`/`quick-task/host.tsx` apply on submit: remember the
 * picked vendor as the repo's new default and auto-save the repo.
 */
export async function createQuickForkTask(
  orch: QuickForkOrchestrator,
  repo: string,
  baseRef: string,
  vendor: VendorId,
): Promise<Task> {
  setRepoLastActiveVendor(repo, vendor)
  addSavedRepo(repo)
  return orch.createTask({ repo, baseRef, vendor })
}

/**
 * Full quick-fork submit flow: create the task, then land the host's
 * selection/entry on it — the same "select then enter" order
 * `createTaskFlow` ends on. Errors are reported via `notifyError`, never
 * thrown, so the host's fire-and-forget `void quickFork(...)` call site
 * stays a one-liner.
 */
export async function runQuickFork(
  orch: QuickForkOrchestrator,
  repo: string,
  result: { baseRef: string; vendor: VendorId },
  hooks: {
    selectTask: (id: string) => void
    enterTask: (id: string) => Promise<void>
    notifyError: (message: string) => void
  },
): Promise<void> {
  try {
    const task = await createQuickForkTask(orch, repo, result.baseRef, result.vendor)
    hooks.selectTask(task.id)
    await hooks.enterTask(task.id)
  } catch (err) {
    console.error("[kobe workspace] quick-fork task.create failed:", err)
    hooks.notifyError(`Couldn't fork task: ${err instanceof Error ? err.message : String(err)}`)
  }
}
