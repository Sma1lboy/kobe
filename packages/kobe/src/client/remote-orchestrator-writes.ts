/**
 * `RemoteOrchestrator`'s write surface — each function forwards one daemon
 * RPC. Split out of `remote-orchestrator.ts` (which was over the repo's
 * 500-line file-size cap) into its own file; same behavior, moved
 * verbatim. The class keeps its public method names/signatures — each is
 * now a 1-line delegate to the matching function here.
 */

import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import type { Automation, AutomationRun } from "@sma1lboy/kobe-daemon/daemon/contracts"
import type { RepoIssues } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { WorkItem } from "@sma1lboy/kobe-daemon/daemon/work-items"
import type { LandResult } from "../orchestrator/land.ts"
import type { Task, TaskId, TaskStatus, VendorId } from "../types/task.ts"
import type { AdoptableWorktree, WorktreeProject } from "../types/worktree.ts"
import { deserializeTask } from "./remote-orchestrator-payloads.ts"

export async function createTaskOp(
  client: KobeDaemonClient,
  input: {
    repo: string
    title?: string
    branch?: string
    baseRef?: string
    vendor?: VendorId
    modelEffort?: string
    groupId?: string
  },
): Promise<Task> {
  // The daemon's `task.create` payload spells effort as `effort`; the task
  // field is `modelEffort` — remap on the wire so the daemon's
  // `optionalString(payload, "effort")` picks it up.
  const { modelEffort, ...rest } = input
  const res = await client.request<{ task: SerializedTask }>("task.create", {
    ...rest,
    effort: modelEffort,
  })
  return deserializeTask(res.task)
}

export async function ensureMainTaskOp(client: KobeDaemonClient, repo: string): Promise<Task> {
  const res = await client.request<{ task: SerializedTask }>("task.ensureMain", { repo })
  return deserializeTask(res.task)
}

export async function ensureWorktreeOp(client: KobeDaemonClient, id: TaskId | string): Promise<string> {
  const res = await client.request<{ worktreePath: string }>("task.ensureWorktree", { taskId: String(id) })
  return res.worktreePath
}

export async function forgetProjectOp(client: KobeDaemonClient, repo: string): Promise<void> {
  await client.request("project.forget", { repo })
}

export async function setTitleOp(client: KobeDaemonClient, id: TaskId | string, title: string): Promise<void> {
  await client.request("task.rename", { taskId: String(id), title })
}

export async function setBranchOp(client: KobeDaemonClient, id: TaskId | string, branch: string): Promise<void> {
  await client.request("task.setBranch", { taskId: String(id), branch })
}

export async function setVendorOp(client: KobeDaemonClient, id: TaskId | string, vendor: VendorId): Promise<void> {
  await client.request("task.setVendor", { taskId: String(id), vendor })
}

export async function setPinnedOp(client: KobeDaemonClient, id: TaskId | string, pinned?: boolean): Promise<void> {
  await client.request("task.pin", { taskId: String(id), pinned })
}

export async function moveTaskOp(client: KobeDaemonClient, id: TaskId | string, delta: -1 | 1): Promise<void> {
  await client.request("task.move", { taskId: String(id), direction: delta < 0 ? "up" : "down" })
}

export async function setArchivedOp(client: KobeDaemonClient, id: TaskId | string, archived?: boolean): Promise<void> {
  await client.request("task.archive", { taskId: String(id), archived })
}

export async function setStatusOp(client: KobeDaemonClient, id: TaskId | string, status: TaskStatus): Promise<void> {
  await client.request("task.status", { taskId: String(id), status })
}

export async function deleteTaskOp(
  client: KobeDaemonClient,
  id: TaskId | string,
  opts?: { force?: boolean },
): Promise<void> {
  await client.request("task.delete", { taskId: String(id), force: opts?.force })
}

/** Explicitly delete one durable attention episode. */
export async function dismissAttentionOp(
  client: KobeDaemonClient,
  taskId: TaskId | string,
  tabId: string | null,
  at: number,
): Promise<boolean> {
  const res = await client.request<{ deleted: boolean }>("attention.dismiss", {
    taskId: String(taskId),
    ...(tabId !== null ? { tabId } : {}),
    at,
  })
  return res.deleted
}

/** Legacy compatibility alias: resolving this exact episode removes it. */
export async function markAttentionReadOp(
  client: KobeDaemonClient,
  taskId: TaskId | string,
  tabId: string | null,
  at: number,
): Promise<boolean> {
  const res = await client.request<{ updated: boolean }>("attention.read", {
    taskId: String(taskId),
    ...(tabId !== null ? { tabId } : {}),
    at,
  })
  return res.updated
}

/** Land a task's branch back into its base repo (`task.land`). Merge or
 *  squash; optionally delete the branch / archive the task after. The daemon
 *  throws with a `LAND_CONFLICT`/`MAIN_CHECKOUT_DIRTY` sentinel in the message
 *  on the guarded failures, which the caller matches to prompt/print. */
export async function landTaskOp(
  client: KobeDaemonClient,
  id: TaskId | string,
  opts?: { strategy?: "merge" | "squash"; deleteBranch?: boolean; archive?: boolean },
): Promise<LandResult> {
  const res = await client.request<{ result: LandResult }>("task.land", {
    taskId: String(id),
    strategy: opts?.strategy,
    deleteBranch: opts?.deleteBranch,
    archive: opts?.archive,
  })
  return res.result
}

export async function discoverAdoptableWorktreesOp(
  client: KobeDaemonClient,
  repo: string,
): Promise<readonly AdoptableWorktree[]> {
  const res = await client.request<{ worktrees: AdoptableWorktree[] }>("worktree.discoverAdoptable", { repo })
  return res.worktrees
}

export async function adoptWorktreeOp(
  client: KobeDaemonClient,
  input: {
    repo: string
    worktreePath: string
    branch?: string
    vendor?: VendorId
    title?: string
  },
): Promise<Task> {
  const res = await client.request<{ task: SerializedTask }>("worktree.adopt", input)
  return deserializeTask(res.task)
}

/** Every worktree of every local saved project — the standalone
 *  worktree-management TUI page (`worktree.list`). `network: false` skips
 *  the slow forge lookups (ls-remote, gh PR states) for an instant first
 *  paint; the page re-requests with them on for the full picture. */
export async function listWorktreesOp(
  client: KobeDaemonClient,
  opts?: { network?: boolean },
): Promise<readonly WorktreeProject[]> {
  const res = await client.request<{ projects: WorktreeProject[] }>("worktree.list", {
    network: opts?.network !== false,
  })
  return res.projects
}

/** Remove a worktree (`worktree.remove`); refuses a dirty one unless
 *  `force` is true — same safety property `GitWorktreeManager.remove`
 *  always had. */
export async function removeWorktreeOp(client: KobeDaemonClient, path: string, force?: boolean): Promise<void> {
  await client.request("worktree.remove", { path, force })
}

/** A repo's daemon-owned issues (`issue.list`) — the TUI kanban page's read. */
export async function listIssuesOp(client: KobeDaemonClient, repoRoot: string): Promise<RepoIssues> {
  return client.request<RepoIssues>("issue.list", { repoRoot })
}

/** One issue-store mutation (`issue.mutate`) — the op union lives in the
 *  daemon's issues-store (create/setStatus/update/link/unlink/delete). The
 *  kanban detail drawer uses `link` (start → task) and `setStatus`. */
export async function mutateIssueOp(client: KobeDaemonClient, repoRoot: string, op: unknown): Promise<RepoIssues> {
  return client.request<RepoIssues>("issue.mutate", { repoRoot, op })
}

/** Scheduled automations (`automation.list`) — the automations page read. */
export async function listAutomationsOp(
  client: KobeDaemonClient,
): Promise<{ automations: Automation[]; keepsDaemonAlive: boolean }> {
  return client.request("automation.list", {})
}

/** Create a schedule (`automation.create`). The daemon validates the cron and
 *  rejects an expression that parses but never fires. */
export async function createAutomationOp(
  client: KobeDaemonClient,
  input: { repo: string; name: string; prompt: string; schedule: string },
): Promise<{ automation: Automation }> {
  return client.request("automation.create", input)
}

/** One automation's run history (`automation.runs`), newest first. */
export async function automationRunsOp(client: KobeDaemonClient, id: string): Promise<{ runs: AutomationRun[] }> {
  return client.request("automation.runs", { id })
}

/** Pause / resume (`automation.update` with just `enabled`). */
export async function setAutomationEnabledOp(
  client: KobeDaemonClient,
  id: string,
  enabled: boolean,
): Promise<{ automation: Automation }> {
  return client.request("automation.update", { id, enabled })
}

/** Fire one now, skipping its precheck (`automation.runNow`). */
export async function runAutomationNowOp(client: KobeDaemonClient, id: string): Promise<{ status: string }> {
  return client.request("automation.runNow", { id })
}

/** Delete an automation and its history (`automation.delete`). */
export async function deleteAutomationOp(client: KobeDaemonClient, id: string): Promise<{ deleted: boolean }> {
  return client.request("automation.delete", { id })
}

/** External tracker items for a repo (`workitem.list`) — the read-only
 *  work-items page. `refresh` bypasses the daemon's 60s cache. */
export async function listWorkItemsOp(
  client: KobeDaemonClient,
  args: { repo: string; state?: string; limit?: number; search?: string; assignee?: string; refresh?: boolean },
): Promise<{ items: WorkItem[] }> {
  return client.request<{ items: WorkItem[] }>("workitem.list", args)
}

/** Start a task on one external item (`workitem.start`) — creates the
 *  worktree, starts the engine with the issue as its first message. */
export async function startWorkItemOp(
  client: KobeDaemonClient,
  args: { repo: string; number: number; vendor?: string; baseRef?: string },
): Promise<{ taskId: string; title: string; started: boolean }> {
  return client.request<{ taskId: string; title: string; started: boolean }>("workitem.start", args)
}

/**
 * Mark a task as the active focus (the session just switched/entered).
 * The daemon publishes it on the `active-task` channel so every Tasks
 * pane + the outer monitor highlight the same task.
 */
export async function setActiveTaskOp(client: KobeDaemonClient, id: TaskId | string | null): Promise<void> {
  await client.request("task.setActive", { taskId: id === null ? null : String(id) })
}
