/**
 * Shared "build a fresh task's session + jump the attached client into it"
 * helpers. Extracted from the quick-task page so the full `n` new-task flow
 * can auto-enter the task it just created (drop the user in the engine pane,
 * ready to type the first prompt) without duplicating the proven jump.
 *
 * `includeInitPrompt` controls the prompt-delivery intent for a freshly-built
 * session:
 *   - quick-task (`f`): false — the user typed a prompt, delivered separately,
 *     so the repo's init-prompt isn't ALSO pasted.
 *   - new-task create (`n`): true — no typed prompt, so let the repo's
 *     init-prompt fire (the same fire-and-forget `ensureSession`'s create path
 *     runs).
 *   - new-task adopt: false — an adopted worktree is existing work being
 *     imported, not a fresh start, so don't paste a first-run prompt into it.
 */

import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { worktreeUsable } from "../../exec/resolve.ts"
import { getSessionOption, sessionExists, tmuxSessionName } from "../../tmux/client.ts"
import type { Task, VendorId } from "../../types/task.ts"

/**
 * Which phase of a Handover failed, so the caller can pick the right toast
 * (the deep `enterTask` owner has no notification context — it throws, the
 * caller surfaces). `cause` carries the underlying error for the worktree phase.
 */
export type HandoverPhase = "no-daemon" | "worktree" | "session"
export class HandoverError extends Error {
  readonly phase: HandoverPhase
  override readonly cause?: unknown
  constructor(phase: HandoverPhase, message: string, cause?: unknown) {
    super(message)
    this.name = "HandoverError"
    this.phase = phase
    this.cause = cause
  }
}

/**
 * Ensure the task's tmux session exists, building it on demand. Mirrors `kobe
 * api add`'s deliver path: ensure the worktree (re-materialise via the daemon
 * when the recorded path is missing/stale), then build the session. Pass
 * `includeInitPrompt` to let the repo's init-prompt fire as the engine's first
 * message; omit it when the caller delivers its own first prompt. `reload` is
 * called after a cold worktree materialise so the caller's task mirror catches
 * up without waiting for the daemon snapshot. Returns true when the session
 * already existed (no build), false when freshly built. Throws {@link
 * HandoverError} on a missing daemon / worktree / session failure.
 */
export async function ensureTaskSession(
  orch: RemoteOrchestrator | null | undefined,
  task: Task,
  repo: string,
  vendor: VendorId | undefined,
  opts: { includeInitPrompt?: boolean; reload?: () => Promise<void> | void } = {},
): Promise<boolean> {
  const session = tmuxSessionName(task.id)
  if (await sessionExists(session)) return true
  let worktree = task.worktreePath
  if (!worktree || !worktreeUsable(worktree)) {
    // Never-entered backlog task (or a stale recorded path): materialise the
    // worktree via the daemon's RPC — only the Orchestrator may `git worktree add`.
    if (!orch) throw new HandoverError("no-daemon", `no daemon; cannot materialise worktree for ${task.id}`)
    try {
      worktree = await orch.ensureWorktree(task.id)
    } catch (err) {
      throw new HandoverError("worktree", `ensureWorktree failed for ${task.id}`, err)
    }
    await opts.reload?.()
  }
  if (!worktree || !worktreeUsable(worktree)) {
    throw new HandoverError("worktree", `task ${task.id} has no usable worktree`)
  }
  const { ensureSession } = await import("../panes/terminal/tmux.ts")
  const { resolveEngineLaunchInit } = await import("../../state/repo-init.ts")
  const launchInit = repo
    ? resolveEngineLaunchInit(repo, worktree, { kind: opts.includeInitPrompt ? "repo-init" : "none" })
    : undefined
  const ok = await ensureSession({
    name: session,
    cwd: worktree,
    command: interactiveEngineCommand(vendor),
    taskId: task.id,
    vendor,
    repo,
    launchInit,
  })
  if (!ok) throw new HandoverError("session", `failed to start tmux session for ${task.id}`)
  return false // freshly built
}

export interface EnterTaskOpts {
  /** Let the repo's init-prompt fire as the engine's first message (and, on a
   *  heal, re-weave it). Off for adopt / when the caller delivers its own prompt. */
  includeInitPrompt?: boolean
  /** Re-run `ensureSession` on an ALREADY-running session to heal vendor/worktree
   *  drift (cwd read from the session's `@kobe_worktree` tag — tasks.json can lag,
   *  KOB-244). A heal failure never blocks the switch. Opt-in: the Tasks pane uses
   *  it; the transitional new-task/quick-task pages don't. */
  heal?: boolean
  /** Save the CURRENT (from) session's layout into the global options before
   *  leaving, so a manual rail/right-column drag becomes the shared shape. */
  captureFrom?: boolean
  /** Refresh the caller's task mirror after a cold worktree materialise. */
  reload?: () => Promise<void> | void
}

/**
 * **Handover** — the single owner of "enter this Task": ensure its tmux Session
 * exists (create cold, or heal a live one), reconcile zen, mark it active, then
 * fit + `switch-client` the attached client into it via {@link enterWindow}. The
 * `switchTo` (Tasks pane) and `jumpToTask` (new-task / quick-task) paths used to
 * each re-implement this sequence and had drifted (jump lacked zen sync; the
 * delete tail lacked the fit). All enter surfaces now funnel here.
 *
 * Throws {@link HandoverError} (the caller toasts) on a build failure; a heal
 * failure on an existing session is swallowed so a live task always switches.
 */
export async function enterTask(
  orch: RemoteOrchestrator | null | undefined,
  task: Task,
  repo: string,
  vendor: VendorId | undefined,
  opts: EnterTaskOpts = {},
): Promise<void> {
  const session = tmuxSessionName(task.id)
  const tmux = await import("../panes/terminal/tmux.ts")
  if (opts.captureFrom) {
    const from = await tmux.currentSessionName()
    if (from && from !== session) await tmux.captureGlobalLayout(from)
  }
  const existed = await ensureTaskSession(orch, task, repo, vendor, {
    includeInitPrompt: opts.includeInitPrompt,
    reload: opts.reload,
  })
  if (existed && opts.heal) {
    try {
      const cwd = (await getSessionOption(session, "@kobe_worktree")) || task.worktreePath || ""
      if (cwd && worktreeUsable(cwd)) {
        const { resolveEngineLaunchInit } = await import("../../state/repo-init.ts")
        const launchInit = repo
          ? resolveEngineLaunchInit(repo, cwd, { kind: opts.includeInitPrompt ? "repo-init" : "none" })
          : undefined
        await tmux.ensureSession({
          name: session,
          cwd,
          command: interactiveEngineCommand(vendor),
          taskId: task.id,
          vendor,
          repo,
          launchInit,
        })
      }
    } catch (err) {
      console.error("[kobe handover] heal failed (continuing to switch):", err)
    }
  }
  // Reconcile the target to the global zen intent BEFORE fitting, so a project
  // you enter inherits zen and the fit accounts for the collapsed layout.
  const { syncSessionZen } = await import("../panes/terminal/layout-actions.ts")
  await syncSessionZen(session)
  await orch?.setActiveTask(task.id).catch(() => {})
  await tmux.enterWindow(session)
}

/**
 * Thin **Handover** wrapper for the transitional new-task / quick-task pages:
 * enter the freshly created task (no from-layout to capture, no live session to
 * heal). Kept as a named convenience over {@link enterTask}; the calling page
 * then exits, leaving the client on the new task's session.
 */
export async function jumpToTask(
  orch: RemoteOrchestrator,
  task: Task,
  repo: string,
  vendor: VendorId,
  opts: { includeInitPrompt?: boolean } = {},
): Promise<void> {
  await enterTask(orch, task, repo, vendor, { includeInitPrompt: opts.includeInitPrompt })
}
