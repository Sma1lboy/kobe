/**
 * `RemoteOrchestrator`'s write surface — each function forwards one daemon
 * RPC. Split out of `remote-orchestrator.ts` (which was over the repo's
 * 500-line file-size cap) into its own file; same behavior, moved
 * verbatim. The class keeps its public method names/signatures — each is
 * now a 1-line delegate to the matching function here.
 */

import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
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
 *  worktree-management TUI page (`worktree.list`). */
export async function listWorktreesOp(client: KobeDaemonClient): Promise<readonly WorktreeProject[]> {
  const res = await client.request<{ projects: WorktreeProject[] }>("worktree.list", {})
  return res.projects
}

/** Remove a worktree (`worktree.remove`); refuses a dirty one unless
 *  `force` is true — same safety property `GitWorktreeManager.remove`
 *  always had. */
export async function removeWorktreeOp(client: KobeDaemonClient, path: string, force?: boolean): Promise<void> {
  await client.request("worktree.remove", { path, force })
}

/**
 * Mark a task as the active focus (the session just switched/entered).
 * The daemon publishes it on the `active-task` channel so every Tasks
 * pane + the outer monitor highlight the same task (KOB-247).
 */
export async function setActiveTaskOp(client: KobeDaemonClient, id: TaskId | string | null): Promise<void> {
  await client.request("task.setActive", { taskId: id === null ? null : String(id) })
}
