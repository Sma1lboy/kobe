
import {
  interactiveEngineCommand,
  withDispatcherProtocol,
  withWorktreeProtocol,
} from "../../kobe/src/engine/interactive-command.ts"
import { quoteShellArgv } from "../../kobe/src/lib/shell-command.ts"
import { resolveEngineLaunchInit } from "../../kobe/src/state/repo-init.ts"
import { killSession, switchClientBeforeKill } from "../../kobe/src/tmux/client.ts"
import { ensureSession, sessionExists, tmuxSessionName } from "../../kobe/src/tui/panes/terminal/tmux.ts"
import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"

async function getTask(link: DaemonRpcClient, taskId: string): Promise<SerializedTask> {
  const { task } = await link.request<{ task: SerializedTask }>("task.get", { taskId })
  return task
}

async function ensureTaskWorktree(
  link: DaemonRpcClient,
  taskId: string,
): Promise<{ task: SerializedTask; worktreePath: string }> {
  const task = await getTask(link, taskId)
  if (task.worktreePath) return { task, worktreePath: task.worktreePath }
  const { worktreePath } = await link.request<{ worktreePath: string | null }>("task.ensureWorktree", { taskId })
  if (!worktreePath) throw new Error(`task ${taskId} has no worktree`)
  return { task, worktreePath }
}

export async function ensureTaskSession(
  link: DaemonRpcClient,
  taskId: string,
): Promise<{ session: string; worktreePath: string }> {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const session = tmuxSessionName(taskId)
  if (!(await sessionExists(session))) {
    const launchInit = resolveEngineLaunchInit(task.repo ?? "", worktreePath, { kind: "repo-init" })
    const ok = await ensureSession({
      name: session,
      cwd: worktreePath,
      command: interactiveEngineCommand(task.vendor, task.modelEffort),
      taskId,
      vendor: task.vendor,
      launchInit,
    })
    if (!ok) throw new Error(`failed to start tmux session for ${taskId}`)
  }
  return { session, worktreePath }
}

export function shellQuote(argv: readonly string[]): string {
  return quoteShellArgv(argv, { bareSafe: true })
}

export async function engineSpec(link: DaemonRpcClient, taskId: string): Promise<{ cwd: string; command: string[] }> {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const protocolTaskId = task.kind === "main" ? undefined : taskId
  const dispatcherTaskId = task.kind === "main" ? taskId : undefined
  const argv = [
    ...withDispatcherProtocol(
      withWorktreeProtocol(interactiveEngineCommand(task.vendor, task.modelEffort), task.vendor, protocolTaskId),
      task.vendor,
      dispatcherTaskId,
    ),
  ]
  const launchInit = resolveEngineLaunchInit(task.repo ?? "", worktreePath, { kind: "none" })
  const quoted = shellQuote(argv)
  const script = launchInit.initScript?.trim() ? `${launchInit.initScript}\n${quoted}` : quoted
  const shell = process.env.SHELL?.trim() || "/bin/zsh"
  return { cwd: worktreePath, command: [shell, "-ilc", script] }
}

export async function terminalSpec(link: DaemonRpcClient, taskId: string): Promise<{ cwd: string; command: string[] }> {
  const { worktreePath } = await ensureTaskWorktree(link, taskId)
  const shell = process.env.SHELL?.trim() || "/bin/zsh"
  return { cwd: worktreePath, command: [shell, "-il"] }
}

export async function tearDownTaskSession(taskId: string): Promise<void> {
  const session = tmuxSessionName(taskId)
  await switchClientBeforeKill(session).catch(() => {})
  await killSession(session).catch(() => {})
}
