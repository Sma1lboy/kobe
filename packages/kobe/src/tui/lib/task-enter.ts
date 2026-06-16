/**
 * Shared "build a fresh task's session + jump the attached client into it"
 * helpers. Extracted from the quick-task page so the full `n` new-task flow
 * can auto-enter the task it just created (drop the user in the engine pane,
 * ready to type the first prompt) without duplicating the proven jump.
 *
 * Two consumers, two prompt policies:
 *   - quick-task (`f`): the user typed a prompt, so it builds with the init
 *     SCRIPT only and delivers the typed prompt itself — `includeInitPrompt`
 *     stays false so the repo's init-prompt isn't ALSO pasted.
 *   - new-task (`n`): no typed prompt, so it builds with `includeInitPrompt`
 *     true and lets the repo's init-prompt fire as the engine's first message
 *     (the same fire-and-forget delivery `ensureSession`'s create path runs).
 */

import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { runTmux, sessionExists, tmuxSessionName } from "../../tmux/client.ts"
import type { Task, VendorId } from "../../types/task.ts"

/**
 * Ensure the task's tmux session exists, building it on demand. Mirrors `kobe
 * api add`'s deliver path: ensure the worktree, then build the session. Pass
 * `includeInitPrompt` to let the repo's init-prompt fire as the engine's first
 * message; omit it when the caller delivers its own first prompt. Returns true
 * when the session already existed (no build), false when freshly built.
 */
export async function ensureTaskSession(
  orch: RemoteOrchestrator,
  task: Task,
  repo: string,
  vendor: VendorId,
  opts: { includeInitPrompt?: boolean } = {},
): Promise<boolean> {
  const session = tmuxSessionName(task.id)
  if (await sessionExists(session)) return true
  let worktree = task.worktreePath
  if (!worktree) worktree = await orch.ensureWorktree(task.id)
  if (!worktree) throw new Error(`task ${task.id} has no worktree`)
  const { ensureSession } = await import("../panes/terminal/tmux.ts")
  const { resolveRepoInit } = await import("../../state/repo-init.ts")
  const init = resolveRepoInit(repo, worktree)
  const ok = await ensureSession({
    name: session,
    cwd: worktree,
    command: interactiveEngineCommand(vendor),
    taskId: task.id,
    vendor,
    repo,
    initScript: init.initScript,
    initPrompt: opts.includeInitPrompt ? init.initPrompt : undefined,
  })
  if (!ok) throw new Error(`failed to start tmux session for ${task.id}`)
  return false // freshly built
}

/**
 * Jump the attached client to the task: mark it active and `switch-client` to
 * its tmux session (building the session first if a caller hasn't already).
 * The calling page then exits; the client is already on the new task's
 * session, so closing the old window doesn't disturb it.
 */
export async function jumpToTask(orch: RemoteOrchestrator, task: Task, repo: string, vendor: VendorId): Promise<void> {
  await ensureTaskSession(orch, task, repo, vendor) // no-op if already built
  await orch.setActiveTask(task.id).catch(() => {})
  // Fit + heal the target to THIS client before switching in, so it doesn't
  // reflow on screen — the calling window's stdout is its own pane, not the
  // full terminal (see prepareWindowForSwitch).
  const { prepareWindowForSwitch } = await import("../panes/terminal/tmux.ts")
  await prepareWindowForSwitch(tmuxSessionName(task.id))
  await runTmux(["switch-client", "-t", `=${tmuxSessionName(task.id)}`])
}
