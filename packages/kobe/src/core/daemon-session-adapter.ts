import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import { resolveLoginShell } from "@sma1lboy/kobe-daemon/daemon/platform-shell"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  deliverToHostedKey,
  ensureHostedEngine,
  ensureHostedSessionHost,
  findHostedEngineKey,
  hostedTaskKeys,
  killHostedSessions,
  listHostedSessions,
  openHostedSessionHost,
} from "../engine/hosted-session.ts"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import { buildEngineSessionLaunch } from "../engine/session-launch.ts"
import { TaskDeletingError } from "../orchestrator/errors.ts"
import type { PromptDeliveryIntent } from "../state/repo-init.ts"
import type { VendorId } from "../types/task.ts"

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

/**
 * {@link ensureTaskSessionAdapter} with an explicit first message instead of
 * the repo's `.kobe/init-prompt.md`. Used by the daemon's automation runner,
 * whose whole job is starting a session that says something specific.
 *
 * `promptIntent: {kind:"explicit"}` makes `buildEngineSessionLaunch` append the
 * text to the engine's OWN argv, so the prompt is part of the spawn rather
 * than a paste racing a cold TUI — the difference matters when no human is
 * watching to retype it.
 */
export async function startTaskSessionWithPromptAdapter(
  link: DaemonRpcClient,
  taskId: string,
  prompt: string,
): Promise<boolean> {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const launch = taskEngineLaunch(task, worktreePath, { kind: "explicit", prompt })
  const host = await ensureHostedSessionHost()
  try {
    const opened = await ensureHostedEngine(host.rpc, worktreePath, launch)
    return opened.alive
  } finally {
    host.close()
  }
}

function taskEngineLaunch(
  task: SerializedTask,
  worktreePath: string,
  promptIntent: PromptDeliveryIntent,
  // per-tab vendor override, the web mirror of EngineTab.vendor
  vendorOverride?: string,
  tabId?: string,
) {
  return buildEngineSessionLaunch({
    task: {
      id: task.id,
      kind: task.kind,
      vendor: vendorOverride ? (vendorOverride as VendorId) : task.vendor,
      repo: task.repo,
    },
    worktreePath,
    shell: resolveLoginShell({ fallback: "/bin/zsh" }),
    argv: vendorOverride
      ? interactiveEngineCommand(vendorOverride as VendorId)
      : interactiveEngineCommand(task.vendor, task.modelEffort),
    promptIntent,
    tabId,
  })
}

export async function engineSpecAdapter(
  link: DaemonRpcClient,
  taskId: string,
  vendor?: string,
  // Web tab identity → exported KOBE_TAB_ID: without it every web PTY engine
  // reported as "tab-1" and per-tab hook attribution collapsed.
  tabId?: string,
) {
  const { task, worktreePath } = await ensureTaskWorktree(link, taskId)
  const launch = taskEngineLaunch(task, worktreePath, { kind: "repo-init" }, vendor, tabId)
  return { cwd: worktreePath, command: [...launch.command] }
}

export async function terminalSpecAdapter(link: DaemonRpcClient, taskId: string) {
  const { worktreePath } = await ensureTaskWorktree(link, taskId)
  return { cwd: worktreePath, command: [resolveLoginShell({ fallback: "/bin/zsh" }), "-il"] }
}

/**
 * Deliver a prompt into a task's LIVE hosted engine session only — never
 * spawns one. Used by the daemon's quota-resume runner: resuming a dead
 * engine would start a fresh context-less session and burn quota on it, so
 * "no alive engine" returns false and the schedule is dropped instead.
 */
export async function deliverPromptToLiveEngineAdapter(
  task: { readonly id: string; readonly vendor?: VendorId; readonly worktreePath: string },
  prompt: string,
): Promise<boolean> {
  const host = await openHostedSessionHost()
  if (!host) return false
  try {
    const sessions = await listHostedSessions(host.rpc)
    const engineBin = interactiveEngineCommand(task.vendor)[0]
    const key = findHostedEngineKey(sessions, task.id, engineBin)
    if (!key) return false
    const delivered = await deliverToHostedKey(host.rpc, key, task.worktreePath, prompt)
    await host.rpc.request("pty.detach", { key }).catch(() => {})
    return delivered
  } catch {
    return false
  } finally {
    host.close()
  }
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
