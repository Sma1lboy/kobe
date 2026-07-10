import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  interactiveEngineCommand,
  withDispatcherProtocol,
  withWorktreeProtocol,
} from "../engine/interactive-command.ts"
import { quoteShellArgv } from "../lib/shell-command.ts"
import { resolveEngineLaunchInit } from "../state/repo-init.ts"
import { killSession, switchClientBeforeKill } from "../tmux/client.ts"
import { ensureSession, sessionExists, tmuxSessionName } from "../tui/panes/terminal/tmux.ts"

async function getTask(link: DaemonRpcClient, taskId: string): Promise<SerializedTask> {
  const { task } = await link.request<{ task: SerializedTask }>("task.get", { taskId })
  return task
}

async function ensureTaskWorktree(link: DaemonRpcClient, taskId: string) {
  const task = await getTask(link, taskId)
  if (task.worktreePath) return { task, worktreePath: task.worktreePath }
  const { worktreePath } = await link.request<{ worktreePath: string | null }>("task.ensureWorktree", { taskId })
  if (!worktreePath) throw new Error(`task ${taskId} has no worktree`)
  return { task, worktreePath }
}

export async function ensureTaskSessionAdapter(link: DaemonRpcClient, taskId: string) {
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

export async function engineSpecAdapter(link: DaemonRpcClient, taskId: string) {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const protocolTaskId = task.kind === "main" ? undefined : taskId
  const dispatcherTaskId = task.kind === "main" ? taskId : undefined
  const argv = withDispatcherProtocol(
    withWorktreeProtocol(interactiveEngineCommand(task.vendor, task.modelEffort), task.vendor, protocolTaskId),
    task.vendor,
    dispatcherTaskId,
  )
  const launchInit = resolveEngineLaunchInit(task.repo ?? "", worktreePath, { kind: "none" })
  const quoted = quoteShellArgv(argv, { bareSafe: true })
  const script = launchInit.initScript?.trim() ? `${launchInit.initScript}\n${quoted}` : quoted
  return { cwd: worktreePath, command: [process.env.SHELL?.trim() || "/bin/zsh", "-ilc", script] }
}

export async function terminalSpecAdapter(link: DaemonRpcClient, taskId: string) {
  const { worktreePath } = await ensureTaskWorktree(link, taskId)
  return { cwd: worktreePath, command: [process.env.SHELL?.trim() || "/bin/zsh", "-il"] }
}

export async function tearDownTaskSessionAdapter(taskId: string): Promise<void> {
  const session = tmuxSessionName(taskId)
  await switchClientBeforeKill(session).catch(() => {})
  await killSession(session).catch(() => {})
}
