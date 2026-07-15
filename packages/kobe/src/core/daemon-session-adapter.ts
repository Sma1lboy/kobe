import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  ensureHostedEngine,
  ensureHostedSessionHost,
  hostedTaskKeys,
  killHostedSessions,
  listHostedSessions,
  openHostedSessionHost,
} from "../engine/hosted-session.ts"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import { buildEngineSessionLaunch } from "../engine/session-launch.ts"
import { TaskDeletingError } from "../orchestrator/errors.ts"
import type { PromptDeliveryIntent } from "../state/repo-init.ts"

async function getTask(link: DaemonRpcClient, taskId: string): Promise<SerializedTask> {
  const { task } = await link.request<{ task: SerializedTask }>("task.get", { taskId })
  return task
}

async function ensureTaskWorktree(link: DaemonRpcClient, taskId: string) {
  const task = await getTask(link, taskId)
  if (task.deletion) throw new TaskDeletingError(taskId)
  if (task.worktreePath) return { task, worktreePath: task.worktreePath }
  const { worktreePath } = await link.request<{ worktreePath: string | null }>("task.ensureWorktree", { taskId })
  if (!worktreePath) throw new Error(`task ${taskId} has no worktree`)
  return { task, worktreePath }
}

export async function ensureTaskSessionAdapter(link: DaemonRpcClient, taskId: string) {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const launch = taskEngineLaunch(task, worktreePath, { kind: "repo-init" })
  const host = await ensureHostedSessionHost()
  try {
    const opened = await ensureHostedEngine(host.rpc, worktreePath, launch)
    if (!opened.alive) throw new Error(`failed to start hosted engine session for ${taskId}`)
  } finally {
    host.close()
  }
  return { session: launch.key, worktreePath }
}

function taskEngineLaunch(task: SerializedTask, worktreePath: string, promptIntent: PromptDeliveryIntent) {
  return buildEngineSessionLaunch({
    task: { id: task.id, kind: task.kind, vendor: task.vendor, repo: task.repo },
    worktreePath,
    shell: process.env.SHELL?.trim() || "/bin/zsh",
    argv: interactiveEngineCommand(task.vendor, task.modelEffort),
    promptIntent,
  })
}

export async function engineSpecAdapter(link: DaemonRpcClient, taskId: string) {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const launch = taskEngineLaunch(task, worktreePath, { kind: "repo-init" })
  return { cwd: worktreePath, command: [...launch.command] }
}

export async function terminalSpecAdapter(link: DaemonRpcClient, taskId: string) {
  const { worktreePath } = await ensureTaskWorktree(link, taskId)
  return { cwd: worktreePath, command: [process.env.SHELL?.trim() || "/bin/zsh", "-il"] }
}

export async function tearDownTaskSessionAdapter(taskId: string): Promise<void> {
  const host = await openHostedSessionHost()
  if (!host) return
  try {
    await killHostedSessions(host.rpc, hostedTaskKeys(await listHostedSessions(host.rpc), taskId))
  } catch {
    // Task mutation already committed; teardown remains best-effort.
  } finally {
    host.close()
  }
}
