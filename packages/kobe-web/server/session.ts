/**
 * Task session + launch-spec routes, implemented bridge-side.
 *
 * Task DATA comes over the daemon protocol (`task.get`, `task.ensureWorktree`
 * — the daemon stays the single writer for the task index). The tmux session
 * + engine launch line are then built locally, with the SAME client-side
 * modules every other kobe host uses (`direct.ts`, the Tasks pane,
 * `kobe api`): `ensureSession`, `resolveRepoInit`, `interactiveEngineCommand`.
 * The bridge runs on the user's machine next to tmux, so there is nothing a
 * daemon-side implementation could reach that this one can't.
 */

import { interactiveEngineCommand } from "../../kobe/src/engine/interactive-command.ts"
import { resolveRepoInit } from "../../kobe/src/state/repo-init.ts"
import { killSession, switchClientBeforeKill } from "../../kobe/src/tmux/client.ts"
import { ensureSession, sessionExists, tmuxSessionName } from "../../kobe/src/tui/panes/terminal/tmux.ts"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { RpcLink } from "./daemon-link.ts"

async function getTask(link: RpcLink, taskId: string): Promise<SerializedTask> {
  const { task } = await link.request<{ task: SerializedTask }>("task.get", { taskId })
  return task
}

async function ensureTaskWorktree(link: RpcLink, taskId: string): Promise<{ task: SerializedTask; worktreePath: string }> {
  const task = await getTask(link, taskId)
  if (task.worktreePath) return { task, worktreePath: task.worktreePath }
  const { worktreePath } = await link.request<{ worktreePath: string | null }>("task.ensureWorktree", { taskId })
  if (!worktreePath) throw new Error(`task ${taskId} has no worktree`)
  return { task, worktreePath }
}

export async function ensureTaskSession(
  link: RpcLink,
  taskId: string,
): Promise<{ session: string; worktreePath: string }> {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const session = tmuxSessionName(taskId)
  if (!(await sessionExists(session))) {
    const init = resolveRepoInit(task.repo ?? "", worktreePath)
    const ok = await ensureSession({
      name: session,
      cwd: worktreePath,
      command: interactiveEngineCommand(task.vendor),
      taskId,
      vendor: task.vendor,
      initScript: init.initScript,
    })
    if (!ok) throw new Error(`failed to start tmux session for ${taskId}`)
  }
  return { session, worktreePath }
}

function shellQuote(argv: readonly string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_/.:=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ")
}

export async function engineSpec(link: RpcLink, taskId: string): Promise<{ cwd: string; command: string[] }> {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const argv = [...interactiveEngineCommand(task.vendor)]
  const init = resolveRepoInit(task.repo ?? "", worktreePath)
  const quoted = shellQuote(argv)
  const script = init.initScript?.trim() ? `${init.initScript}\n${quoted}` : quoted
  const shell = process.env.SHELL?.trim() || "/bin/zsh"
  return { cwd: worktreePath, command: [shell, "-ilc", script] }
}

export async function terminalSpec(link: RpcLink, taskId: string): Promise<{ cwd: string; command: string[] }> {
  const { worktreePath } = await ensureTaskWorktree(link, taskId)
  const shell = process.env.SHELL?.trim() || "/bin/zsh"
  return { cwd: worktreePath, command: [shell, "-il"] }
}

/**
 * Kill a task's canonical tmux session (and the engine inside it) after the
 * task is archived or deleted. The daemon never touches tmux by design, so
 * every front-end that commits an archive/delete RPC owns this follow-up —
 * the TUI does it in its flows, `kobe api` does it in its CLI process, and
 * the web bridge does it here (without this, a web delete leaves the engine
 * subprocess running, orphaned and invisible to every kobe UI). Best-effort:
 * the RPC is already committed, so a teardown failure must never throw back.
 */
export async function tearDownTaskSession(taskId: string): Promise<void> {
  const session = tmuxSessionName(taskId)
  // Switch any attached client away first so the kill doesn't blank a
  // terminal (no-op when nothing is attached to that session).
  await switchClientBeforeKill(session).catch(() => {})
  await killSession(session).catch(() => {})
}
