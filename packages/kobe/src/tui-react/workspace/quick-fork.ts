/**
 * Quick-fork (issue #17, KOB-74) — resolve the composer's seed defaults from
 * the active task, and drive `orch.createTask` with the same tmux-parity
 * side effects `quick-task/host.tsx` and the shared `createTaskFlow`
 * (`tui/lib/task-actions.ts`) both perform: `addSavedRepo` + `setRepoLastActiveVendor`
 * before create, `selectTask`/`enterTask` after. Also owns the phase-2
 * first-prompt handoff (`useQuickFork`): the composer resolves on the
 * SOURCE task's TerminalTabs mount, but the prompt has to reach the
 * NEW task's mount, so the pending prompt is held here, keyed by task id.
 *
 * Split out of `TerminalTabs.tsx`/`host.tsx` purely for the file-size cap —
 * both hosts sit close to the 500-line limit already.
 */

import { errorMessage } from "@/lib/error-message"
import { useState } from "react"
import { engineDisplayName } from "../../engine/interactive-command"
import { addSavedRepo } from "../../state/repos"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs"
import { appendAttachmentRefs } from "../../tui/lib/attachments"
import { DEFAULT_BASE_REF, getCurrentBranch } from "../../tui/lib/git-snapshot"
import { repoBasename } from "../../tui/panes/sidebar/groups"
import type { Task, VendorId } from "../../types/task"
import type { QuickTaskComposerOptions, QuickTaskResult } from "../component/quick-task-composer"

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
 * thrown. Returns the created task's id (undefined on failure) so the
 * caller can hand its first-prompt delivery to the new task's TerminalTabs
 * mount (phase 2, issue #17).
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
): Promise<string | undefined> {
  try {
    const task = await createQuickForkTask(orch, repo, result.baseRef, result.vendor)
    hooks.selectTask(task.id)
    await hooks.enterTask(task.id)
    return task.id
  } catch (err) {
    console.error("[kobe workspace] quick-fork task.create failed:", err)
    hooks.notifyError(`Couldn't fork task: ${errorMessage(err)}`)
    return undefined
  }
}

export interface PendingInitialPrompt {
  readonly taskId: string
  readonly prompt: string
}

export interface UseQuickForkResult {
  /** Pass to `ShowWorkspace`'s `onQuickFork` prop. */
  readonly onQuickFork: (repo: string, result: QuickTaskResult) => void
  /** Pass to `ShowWorkspace`'s `initialPrompt` prop, gated on the currently
   *  selected task — undefined for every task except the one just forked. */
  readonly initialPromptFor: (taskId: string | undefined) => string | undefined
}

/**
 * Host-level quick-fork wiring: runs the create+enter flow, then holds the
 * prompt for the ONE render cycle it takes `ShowWorkspace` to remount
 * `TerminalTabs` on the new task (a plain `{ taskId, prompt } | null`, not
 * a Map — `runQuickFork`'s `enterTask` already lands `selectedTask` on the
 * new task before this resolves, so there's only ever one pending prompt).
 */
export function useQuickFork(
  orch: QuickForkOrchestrator,
  hooks: {
    selectTask: (id: string) => void
    enterTask: (id: string) => Promise<void>
    notifyError: (message: string) => void
  },
): UseQuickForkResult {
  const [pending, setPending] = useState<PendingInitialPrompt | null>(null)

  async function onQuickFork(repo: string, result: QuickTaskResult): Promise<void> {
    const taskId = await runQuickFork(orch, repo, result, hooks)
    if (taskId) setPending({ taskId, prompt: appendAttachmentRefs(result.prompt, result.attachments) })
  }

  function initialPromptFor(taskId: string | undefined): string | undefined {
    return taskId && pending?.taskId === taskId ? pending.prompt : undefined
  }

  return { onQuickFork: (repo, result) => void onQuickFork(repo, result), initialPromptFor }
}
