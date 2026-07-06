import { homedir } from "node:os"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { worktreeUsable } from "../../exec/resolve.ts"
import { getSessionOption, sessionExists, tmuxSessionName } from "../../tmux/client.ts"
import type { Task, VendorId } from "../../types/task.ts"

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

export async function ensureTaskSession(
  orch: RemoteOrchestrator | null | undefined,
  task: Task,
  repo: string,
  vendor: VendorId | undefined,
  opts: { includeInitPrompt?: boolean; reload?: () => Promise<void> | void } = {},
): Promise<boolean> {
  const session = tmuxSessionName(task.id)
  if (await sessionExists(session)) return true

  const { archivedHistoryPreviewEnabled } = await import("../../state/archived-history.ts")
  if (task.archived && archivedHistoryPreviewEnabled()) {
    const { ensureSession } = await import("../panes/terminal/tmux.ts")
    const recorded = task.worktreePath ?? ""
    const spawnCwd = recorded && worktreeUsable(recorded) ? recorded : repo && worktreeUsable(repo) ? repo : homedir()
    const ok = await ensureSession({
      name: session,
      cwd: spawnCwd,
      command: interactiveEngineCommand(vendor),
      taskId: task.id,
      vendor,
      repo,
      archived: true,
      archivedWorktree: recorded || spawnCwd,
      title: task.title,
    })
    if (!ok) throw new HandoverError("session", `failed to start history session for ${task.id}`)
    return false
  }

  let worktree = task.worktreePath
  if (!worktree || !worktreeUsable(worktree)) {
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
  const { previewModeEnabled } = await import("../../state/preview-mode.ts")
  if (previewModeEnabled(task.id) && archivedHistoryPreviewEnabled()) {
    const ok = await ensureSession({
      name: session,
      cwd: worktree,
      command: interactiveEngineCommand(vendor),
      taskId: task.id,
      vendor,
      repo,
      preview: true,
      archivedWorktree: worktree,
      title: task.title,
    })
    if (!ok) throw new HandoverError("session", `failed to start preview session for ${task.id}`)
    return false
  }
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
  return false
}

export interface EnterTaskOpts {
  includeInitPrompt?: boolean
  heal?: boolean
  captureFrom?: boolean
  reload?: () => Promise<void> | void
  isCurrent?: () => boolean
}

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
  const { syncSessionZen } = await import("../panes/terminal/layout-actions.ts")
  await syncSessionZen(session)
  if (opts.isCurrent && !opts.isCurrent()) return
  await orch?.setActiveTask(task.id).catch(() => {})
  await tmux.enterWindow(session)
}

export async function jumpToTask(
  orch: RemoteOrchestrator,
  task: Task,
  repo: string,
  vendor: VendorId,
  opts: { includeInitPrompt?: boolean } = {},
): Promise<void> {
  await enterTask(orch, task, repo, vendor, { includeInitPrompt: opts.includeInitPrompt })
}
